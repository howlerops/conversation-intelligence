import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AnalysisWorker,
  ConversationIntelligenceService,
  SqliteJobStore,
  StubCanonicalAnalysisEngine,
} from '../src';
import { canonicalExtractionSchema } from '../src/contracts/analysis';
import { PiiMaskInput, PiiTextMasker } from '../src/pii/masking';
import { TenantPackDraft, TranscriptInputDraft } from '../src/contracts';
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

async function waitForCompletion(
  service: ConversationIntelligenceService,
  jobId: string,
): Promise<Awaited<ReturnType<ConversationIntelligenceService['getJob']>>> {
  for (let index = 0; index < 80; index += 1) {
    const job = await service.getJob(jobId);
    if (job?.status === 'COMPLETED' || job?.status === 'FAILED') {
      return job;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Job ${jobId} did not finish in time.`);
}

describe('ConversationIntelligenceService', () => {
  const tempDirs: string[] = [];
  const closables: Closable[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      closables.map(async (closable) => {
        closable.close();
      }),
    );
    closables.length = 0;

    await Promise.all(tempDirs.map((path) => rm(path, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('queues SQLite-backed jobs, masks PII, and exposes review queue entries', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-service-'));
    tempDirs.push(rootDir);

    const store = new SqliteJobStore(join(rootDir, 'jobs.sqlite'));
    closables.push(store);
    await store.initialize();

    const service = new ConversationIntelligenceService({
      store,
      engine: new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
        overallEndUserSentiment: {
          polarity: 'NEGATIVE',
          intensity: 0.7,
          confidence: 0.6,
          rationale: 'Low-confidence extraction contaminated by admin note evidence.',
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
        summary: 'Review needed because the extraction uses admin-note evidence.',
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
      workerId: 'worker_test_service',
    });
    worker.start();

    const transcript = structuredClone(transcriptWithAdminNote) as TranscriptInputDraft;
    transcript.turns[0].text = 'Reach me at sam@example.com with case ACC-4455.';

    try {
      const queued = await service.submitJob({
        transcript,
        tenantPack: tenantPackFixture as TenantPackDraft,
        piiConfig: {
          enabled: true,
          maskDisplayNames: false,
          customRegexRules: [],
        },
      });

      expect(queued.status).toBe('QUEUED');
      expect(queued.request?.transcript.turns[0].text).toContain('[PII:EMAIL]');
      expect(queued.request?.transcript.turns[0].text).toContain('[PII:ACCOUNT]');
      expect(queued.piiRedactionSummary?.ruleHits.EMAIL).toBe(1);
      expect(queued.piiRedactionSummary?.ruleHits.ACCOUNT_TOKEN).toBe(1);

      const completed = await waitForCompletion(service, queued.jobId);

      expect(completed?.status).toBe('COMPLETED');
      expect(completed?.result?.review.state).toBe('NEEDS_REVIEW');
      expect(completed?.result?.piiRedactionSummary?.redactionCount).toBe(2);

      const reviewQueue = await service.listReviewQueue();
      expect(reviewQueue.items.length).toBe(1);
      expect(reviewQueue.items[0].jobId).toBe(queued.jobId);
    } finally {
      await worker.stop();
    }
  });
});
