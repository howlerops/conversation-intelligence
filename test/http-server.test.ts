import { mkdtemp, rm } from 'fs/promises';
import { Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AnalysisWorker,
  ConversationIntelligenceService,
  SqliteJobStore,
  StubCanonicalAnalysisEngine,
  startConversationIntelligenceServer,
} from '../src';
import { canonicalExtractionSchema } from '../src/contracts/analysis';
import { PiiMaskInput, PiiTextMasker } from '../src/pii/masking';
import transcriptFixture from '../fixtures/transcript.support.basic.json';
import transcriptWithAdminNote from '../fixtures/transcript.support.admin-note.json';
import tenantPackFixture from '../fixtures/tenant-pack.support.acme.json';

type Closable = {
  close(): void;
};

function createAccountMasker(): PiiTextMasker {
  return {
    name: 'ACCOUNT_TOKEN',
    mask(input: PiiMaskInput) {
      let replacements = 0;
      const value = input.value.replace(/\bACC-\d{4}\b/g, () => {
        replacements += 1;
        return '[PII:ACCOUNT]';
      });

      return { value, replacements };
    },
  };
}

function getBaseUrl(server: Server): string {
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to an ephemeral TCP port.');
  }

  return `http://127.0.0.1:${address.port}`;
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function waitForCompletedJob(baseUrl: string, jobId: string): Promise<any> {
  for (let index = 0; index < 80; index += 1) {
    const response = await fetch(`${baseUrl}/v1/jobs/${jobId}`);
    const body = await response.json();

    if (body.status === 'COMPLETED' || body.status === 'FAILED') {
      return body;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Job ${jobId} did not finish in time.`);
}

describe('conversation intelligence HTTP server', () => {
  const tempDirs: string[] = [];
  const servers: Server[] = [];
  const closables: Closable[] = [];
  const workers: AnalysisWorker[] = [];

  afterEach(async () => {
    await Promise.allSettled(workers.map(async (worker) => worker.stop()));
    workers.length = 0;

    await Promise.allSettled(servers.map(async (server) => stopServer(server)));
    servers.length = 0;

    await Promise.allSettled(closables.map(async (closable) => closable.close()));
    closables.length = 0;

    await Promise.all(tempDirs.map((path) => rm(path, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('applies PII masking on synchronous /v1/analyze requests', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-http-analyze-'));
    tempDirs.push(rootDir);

    const store = new SqliteJobStore(join(rootDir, 'jobs.sqlite'));
    closables.push(store);
    await store.initialize();

    const service = new ConversationIntelligenceService({
      store,
      engine: new StubCanonicalAnalysisEngine((input) => canonicalExtractionSchema.parse({
        overallEndUserSentiment: {
          polarity: 'NEGATIVE',
          intensity: 0.8,
          confidence: 0.94,
          rationale: input.context.includes('sam@example.com') || input.context.includes('ORD-1234')
            ? 'Raw PII leaked into the engine context.'
            : 'Only masked content reached the engine.',
        },
        aspectSentiments: [],
        canonicalEvents: [],
        canonicalKeyMoments: [],
        summary: input.context.includes('sam@example.com') || input.context.includes('ORD-1234')
          ? 'raw pii leaked'
          : 'masked pii only',
        review: {
          state: 'VERIFIED',
          reasons: [],
        },
      })),
      clock: () => new Date('2026-03-28T00:00:00.000Z'),
    });

    const server = await startConversationIntelligenceServer(service, 0);
    servers.push(server);
    const baseUrl = getBaseUrl(server);

    const transcript = structuredClone(transcriptFixture);
    transcript.turns[0].text = 'Email sam@example.com about order ORD-1234.';

    const response = await fetch(`${baseUrl}/v1/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        transcript,
        tenantPack: tenantPackFixture,
        piiConfig: {
          enabled: true,
          maskDisplayNames: false,
          customRegexRules: [
            {
              name: 'ORDER_ID',
              pattern: '\\bORD-\\d+\\b',
              flags: 'g',
              replacement: '[PII:ORDER]',
            },
          ],
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.summary).toBe('masked pii only');
    expect(body.piiRedactionSummary.redactionCount).toBe(2);
    expect(body.piiRedactionSummary.ruleHits.EMAIL).toBe(1);
    expect(body.piiRedactionSummary.ruleHits.ORDER_ID).toBe(1);
  });

  it('processes queued jobs over HTTP and exposes the review queue', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-http-jobs-'));
    tempDirs.push(rootDir);

    const store = new SqliteJobStore(join(rootDir, 'jobs.sqlite'));
    closables.push(store);
    await store.initialize();

    const service = new ConversationIntelligenceService({
      store,
      engine: new StubCanonicalAnalysisEngine((input) => canonicalExtractionSchema.parse({
        overallEndUserSentiment: {
          polarity: 'NEGATIVE',
          intensity: 0.72,
          confidence: 0.62,
          rationale: input.context.includes('sam@example.com') || input.context.includes('ACC-4455')
            ? 'Raw PII leaked into the queued engine context.'
            : 'Admin-note evidence forces review with masked context only.',
        },
        aspectSentiments: [
          {
            target: 'resolution process',
            aspect: 'trust',
            literalSentiment: 'NEGATIVE',
            intendedSentiment: 'NEGATIVE',
            sarcasm: false,
            confidence: 0.61,
            rationale: 'Evidence points to an internal note instead of the end user.',
            evidence: [
              {
                turnId: 't2',
                speakerRole: 'ADMIN',
                quote: 'Customer appears frustrated.',
              },
            ],
          },
        ],
        canonicalEvents: [],
        canonicalKeyMoments: [],
        summary: 'Review needed because admin-note evidence is ineligible.',
        review: {
          state: 'VERIFIED',
          reasons: [],
        },
      })),
      clock: () => new Date('2026-03-28T00:00:00.000Z'),
      piiMaskers: [createAccountMasker()],
    });

    const worker = new AnalysisWorker({
      service,
      pollIntervalMs: 10,
      workerId: 'worker_http_test',
    });
    worker.start();
    workers.push(worker);

    const server = await startConversationIntelligenceServer(service, 0);
    servers.push(server);
    const baseUrl = getBaseUrl(server);

    const transcript = structuredClone(transcriptWithAdminNote);
    transcript.turns[0].text = 'Call 602-555-0100 or email sam@example.com about ACC-4455.';

    const queueResponse = await fetch(`${baseUrl}/v1/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        transcript,
        tenantPack: tenantPackFixture,
        piiConfig: {
          enabled: true,
          maskDisplayNames: false,
          customRegexRules: [],
        },
      }),
    });

    expect(queueResponse.status).toBe(202);
    const queuedJob = await queueResponse.json();
    expect(queuedJob.request.transcript.turns[0].text).toContain('[PII:PHONE]');
    expect(queuedJob.request.transcript.turns[0].text).toContain('[PII:EMAIL]');
    expect(queuedJob.request.transcript.turns[0].text).toContain('[PII:ACCOUNT]');

    const completedJob = await waitForCompletedJob(baseUrl, queuedJob.jobId);
    expect(completedJob.status).toBe('COMPLETED');
    expect(completedJob.result.review.state).toBe('NEEDS_REVIEW');
    expect(completedJob.result.piiRedactionSummary.redactionCount).toBe(3);

    const reviewQueueResponse = await fetch(`${baseUrl}/v1/review-queue`);
    expect(reviewQueueResponse.status).toBe(200);
    const reviewQueue = await reviewQueueResponse.json();

    expect(reviewQueue.items).toHaveLength(1);
    expect(reviewQueue.items[0].jobId).toBe(queuedJob.jobId);
  });
});
