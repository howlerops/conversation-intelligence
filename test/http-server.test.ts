import { mkdtemp, rm } from 'fs/promises';
import { Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AnalysisWorker,
  ConversationIntelligenceService,
  FileTenantAdminConfigRegistry,
  FileTenantPackRegistry,
  PrometheusRuntimeObservability,
  SqliteJobStore,
  startConversationIntelligenceServer,
} from '../src';
import { StubCanonicalAnalysisEngine } from '../src/rlm/engine';
import { analysisJobRecordSchema } from '../src/contracts/jobs';
import { canonicalExtractionSchema, conversationAnalysisSchema } from '../src/contracts/analysis';
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

async function waitForCompletedJob(baseUrl: string, jobId: string, headers: HeadersInit): Promise<any> {
  for (let index = 0; index < 80; index += 1) {
    const response = await fetch(`${baseUrl}/v1/runs/${jobId}`, { headers });
    const body = await response.json();

    if (body.status === 'COMPLETED' || body.status === 'FAILED') {
      return body;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Job ${jobId} did not finish in time.`);
}

async function collectSseEventsUntil(
  url: string,
  headers: HeadersInit,
  stopEventType: string,
): Promise<string[]> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers,
    signal: controller.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Unexpected SSE response: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const eventTypes: string[] = [];
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';

      for (const chunk of chunks) {
        const eventLine = chunk
          .split('\n')
          .find((line) => line.startsWith('event: '));

        if (!eventLine) {
          continue;
        }

        const eventType = eventLine.replace('event: ', '').trim();
        eventTypes.push(eventType);

        if (eventType === stopEventType) {
          controller.abort();
          return eventTypes;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'AbortError') {
      throw error;
    }
  }

  return eventTypes;
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

  it('applies tenant-scoped auth to synchronous /v1/analyze requests', async () => {
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
          comments: [],
          history: [],
        },
      })),
      clock: () => new Date('2026-03-28T00:00:00.000Z'),
    });

    const server = await startConversationIntelligenceServer(service, {
      port: 0,
      clock: () => new Date('2026-03-28T00:45:00.000Z'),
      auth: {
        mode: 'api_key',
        apiKeys: [
          {
            token: 'token-acme',
            tenantId: 'tenant_acme',
            principalId: 'svc_acme',
          },
        ],
      },
    });
    servers.push(server);
    const baseUrl = getBaseUrl(server);
    const headers = {
      'content-type': 'application/json',
      authorization: 'Bearer token-acme',
    };

    const transcript = structuredClone(transcriptFixture);
    transcript.turns[0].text = 'Email sam@example.com about order ORD-1234.';

    const successResponse = await fetch(`${baseUrl}/v1/analyze`, {
      method: 'POST',
      headers,
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

    expect(successResponse.status).toBe(200);
    const successBody = await successResponse.json();
    expect(successBody.summary).toBe('masked pii only');
    expect(successBody.piiRedactionSummary.redactionCount).toBe(2);

    const forbiddenResponse = await fetch(`${baseUrl}/v1/analyze`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        transcript: {
          ...transcript,
          tenantId: 'tenant_support_other',
        },
        tenantPack: {
          ...tenantPackFixture,
          tenantId: 'tenant_support_other',
        },
      }),
    });

    expect(forbiddenResponse.status).toBe(403);
  });

  it('streams run events, scopes list/read endpoints, and records audit events', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-http-runs-'));
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
          comments: [],
          history: [],
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

    const server = await startConversationIntelligenceServer(service, {
      port: 0,
      clock: () => new Date('2026-03-28T00:45:00.000Z'),
      auth: {
        mode: 'api_key',
        apiKeys: [
          {
            token: 'token-acme',
            tenantId: 'tenant_acme',
            principalId: 'svc_acme',
          },
        ],
      },
      ssePollIntervalMs: 25,
    });
    servers.push(server);
    const baseUrl = getBaseUrl(server);
    const authHeaders = {
      authorization: 'Bearer token-acme',
    };

    const transcript = structuredClone(transcriptWithAdminNote);
    transcript.turns[0].text = 'Call 602-555-0100 or email sam@example.com about ACC-4455.';

    const queueResponse = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        ...authHeaders,
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
    const queuedRun = await queueResponse.json();
    expect(queuedRun.request.transcript.turns[0].text).toContain('[PII:PHONE]');
    expect(queuedRun.request.transcript.turns[0].text).toContain('[PII:EMAIL]');
    expect(queuedRun.request.transcript.turns[0].text).toContain('[PII:ACCOUNT]');

    const sseEvents = await collectSseEventsUntil(
      `${baseUrl}/v1/runs/${queuedRun.jobId}/stream`,
      authHeaders,
      'RUN_COMPLETED',
    );
    expect(sseEvents).toContain('RUN_CREATED');
    expect(sseEvents).toContain('RUN_COMPLETED');

    const completedRun = await waitForCompletedJob(baseUrl, queuedRun.jobId, authHeaders);
    expect(completedRun.status).toBe('COMPLETED');
    expect(completedRun.result.review.state).toBe('NEEDS_REVIEW');

    const runListResponse = await fetch(`${baseUrl}/v1/runs`, {
      headers: authHeaders,
    });
    expect(runListResponse.status).toBe(200);
    const runList = await runListResponse.json();
    expect(runList.runs).toHaveLength(1);

    const runEventsResponse = await fetch(`${baseUrl}/v1/runs/${queuedRun.jobId}/events`, {
      headers: authHeaders,
    });
    expect(runEventsResponse.status).toBe(200);
    const runEvents = await runEventsResponse.json();
    expect(runEvents.events.map((event: { type: string }) => event.type)).toEqual([
      'RUN_CREATED',
      'PII_MASKED',
      'RUN_CLAIMED',
      'LLM_STARTED',
      'LLM_COMPLETED',
      'REVIEW_REQUIRED',
      'RUN_COMPLETED',
    ]);

    const reviewQueueResponse = await fetch(`${baseUrl}/v1/review-queue`, {
      headers: authHeaders,
    });
    expect(reviewQueueResponse.status).toBe(200);
    const reviewQueue = await reviewQueueResponse.json();
    expect(reviewQueue.items).toHaveLength(1);
    expect(reviewQueue.items[0].jobId).toBe(queuedRun.jobId);

    const auditEvents = await service.listAuditEvents('tenant_acme');
    const auditActions = auditEvents.items.map((event) => event.action);
    expect(auditActions).toContain('run.created');
    expect(auditActions).toContain('run.stream.opened');
    expect(auditActions).toContain('run.list');
    expect(auditActions).toContain('run.events.read');
    expect(auditActions).toContain('review_queue.read');
    expect(auditActions.filter((action) => action === 'run.read').length).toBeGreaterThan(0);
  });

  it('serves the self-hosted run console without requiring API auth for the shell', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-http-ui-'));
    tempDirs.push(rootDir);

    const store = new SqliteJobStore(join(rootDir, 'jobs.sqlite'));
    closables.push(store);
    await store.initialize();

    const service = new ConversationIntelligenceService({
      store,
      engine: new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
        overallEndUserSentiment: {
          polarity: 'NEUTRAL',
          intensity: 0.1,
          confidence: 0.95,
          rationale: 'UI shell test.',
        },
        aspectSentiments: [],
        canonicalEvents: [],
        canonicalKeyMoments: [],
        summary: 'UI shell test.',
        review: {
          state: 'VERIFIED',
          reasons: [],
          comments: [],
          history: [],
        },
      })),
    });

    const server = await startConversationIntelligenceServer(service, {
      port: 0,
      auth: {
        mode: 'api_key',
        apiKeys: [
          {
            token: 'token-ui',
            tenantId: 'tenant_support_acme',
            principalId: 'svc_ui',
          },
        ],
      },
      ui: {
        enabled: true,
        title: 'CI Workflow Console',
      },
    });
    servers.push(server);

    const baseUrl = getBaseUrl(server);

    const rootResponse = await fetch(baseUrl, {
      redirect: 'manual',
    });
    expect(rootResponse.status).toBe(302);
    expect(rootResponse.headers.get('location')).toBe('/app');

    const appResponse = await fetch(`${baseUrl}/app`);
    expect(appResponse.status).toBe(200);
    expect(appResponse.headers.get('content-type')).toContain('text/html');

    const appHtml = await appResponse.text();
    expect(appHtml).toContain('CI Workflow Console');
    expect(appHtml).toContain('/v1/runs');
    expect(appHtml).toContain('/v1/review-analytics');
    expect(appHtml).toContain('/v1/tenant-packs/active');
    expect(appHtml).toContain('Load Active');
    expect(appHtml).toContain('Publish Approval');
    expect(appHtml).toContain('Add Comment');
    expect(appHtml).toContain('Evaluate Canary');
    expect(appHtml).toContain('Promote Canary');
    expect(appHtml).toContain('Model Validation');
    expect(appHtml).toContain('Refresh Exports');
    expect(appHtml).toContain('Recommend Thresholds');
    expect(appHtml).toContain('Run Validation');
    expect(appHtml).toContain('Bulk Verify');
    expect(appHtml).toContain('Filter review items');
    expect(appHtml).toContain('Audit Events');
    expect(appHtml).toContain('SLA');
    expect(appHtml).toContain('Assign To Me');
    expect(appHtml).toContain('EventSource');
  });

  it('records analyst review decisions and removes resolved runs from the review queue', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-http-review-action-'));
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
          confidence: 0.91,
          rationale: 'Manual analyst review test.',
        },
        aspectSentiments: [],
        canonicalEvents: [],
        canonicalKeyMoments: [],
        summary: 'Manual analyst review test.',
        review: {
          state: 'NEEDS_REVIEW',
          reasons: ['Confidence is borderline.'],
          comments: [],
          history: [],
        },
      })),
      clock: () => new Date('2026-03-28T00:00:00.000Z'),
    });

    const worker = new AnalysisWorker({
      service,
      workerId: 'review-worker',
      pollIntervalMs: 10,
    });
    workers.push(worker);
    worker.start();

    const server = await startConversationIntelligenceServer(service, {
      port: 0,
      auth: {
        mode: 'api_key',
        apiKeys: [
          {
            token: 'token-review',
            tenantId: 'tenant_acme',
            principalId: 'analyst_1',
            principalType: 'USER',
          },
        ],
      },
    });
    servers.push(server);

    const baseUrl = getBaseUrl(server);
    const headers = {
      authorization: 'Bearer token-review',
      'content-type': 'application/json',
    };

    const queueResponse = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        transcript: transcriptFixture,
        tenantPack: tenantPackFixture,
      }),
    });
    expect(queueResponse.status).toBe(202);
    const queuedRun = await queueResponse.json();

    const completedRun = await waitForCompletedJob(baseUrl, queuedRun.jobId, headers);
    expect(completedRun.result.review.state).toBe('NEEDS_REVIEW');

    const assignmentResponse = await fetch(`${baseUrl}/v1/runs/${queuedRun.jobId}/assignment`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        note: 'Analyst taking ownership.',
      }),
    });
    expect(assignmentResponse.status).toBe(200);
    const assignedRun = await assignmentResponse.json();
    expect(assignedRun.result.review.assignment.assigneeId).toBe('analyst_1');

    const analyticsBeforeReviewResponse = await fetch(`${baseUrl}/v1/review-analytics`, {
      headers: {
        authorization: 'Bearer token-review',
      },
    });
    expect(analyticsBeforeReviewResponse.status).toBe(200);
    const analyticsBeforeReview = await analyticsBeforeReviewResponse.json();
    expect(analyticsBeforeReview.pendingCount).toBe(1);
    expect(analyticsBeforeReview.assignedCount).toBe(1);
    expect(analyticsBeforeReview.sla.pendingTargetMinutes).toBeGreaterThan(0);

    const commentResponse = await fetch(`${baseUrl}/v1/runs/${queuedRun.jobId}/comments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        comment: 'Initial analyst note before resolution.',
      }),
    });
    expect(commentResponse.status).toBe(200);
    const commentedRun = await commentResponse.json();
    expect(commentedRun.result.review.comments).toHaveLength(1);
    expect(commentedRun.result.review.comments[0].actorId).toBe('analyst_1');

    const reviewResponse = await fetch(`${baseUrl}/v1/runs/${queuedRun.jobId}/review`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        decision: 'VERIFY',
        note: 'Human analyst confirmed this is safe to verify.',
      }),
    });
    expect(reviewResponse.status).toBe(200);
    const reviewedRun = await reviewResponse.json();
    expect(reviewedRun.result.review.state).toBe('VERIFIED');
    expect(reviewedRun.result.review.resolution.actorId).toBe('analyst_1');
    expect(reviewedRun.result.review.resolution.decision).toBe('VERIFY');

    const runEventsResponse = await fetch(`${baseUrl}/v1/runs/${queuedRun.jobId}/events`, {
      headers: {
        authorization: 'Bearer token-review',
      },
    });
    expect(runEventsResponse.status).toBe(200);
    const runEvents = await runEventsResponse.json();
    expect(runEvents.events.map((event: { type: string }) => event.type)).toEqual(expect.arrayContaining([
      'ANALYST_COMMENT_ADDED',
      'ANALYST_REVIEW_RECORDED',
    ]));

    const auditResponse = await fetch(`${baseUrl}/v1/runs/${queuedRun.jobId}/audit`, {
      headers: {
        authorization: 'Bearer token-review',
      },
    });
    expect(auditResponse.status).toBe(200);
    const auditSnapshot = await auditResponse.json();
    expect(auditSnapshot.items.map((event: { action: string }) => event.action)).toEqual(expect.arrayContaining([
      'run.assignment.updated',
      'run.comment.added',
      'run.review.updated',
    ]));

    const reviewQueueResponse = await fetch(`${baseUrl}/v1/review-queue`, {
      headers: {
        authorization: 'Bearer token-review',
      },
    });
    expect(reviewQueueResponse.status).toBe(200);
    const reviewQueue = await reviewQueueResponse.json();
    expect(reviewQueue.items).toHaveLength(0);

    const analyticsAfterReviewResponse = await fetch(`${baseUrl}/v1/review-analytics`, {
      headers: {
        authorization: 'Bearer token-review',
      },
    });
    expect(analyticsAfterReviewResponse.status).toBe(200);
    const analyticsAfterReview = await analyticsAfterReviewResponse.json();
    expect(analyticsAfterReview.pendingCount).toBe(0);
    expect(analyticsAfterReview.decisionCounts.VERIFY).toBe(1);
    expect(analyticsAfterReview.resultingStateCounts.VERIFIED).toBe(1);

    const auditEvents = await service.listAuditEvents('tenant_acme');
    expect(auditEvents.items.map((event) => event.action)).toContain('run.assignment.updated');
    expect(auditEvents.items.map((event) => event.action)).toContain('run.comment.added');
    expect(auditEvents.items.map((event) => event.action)).toContain('run.review.updated');
    expect(auditEvents.items.map((event) => event.action)).toContain('review_analytics.read');
    expect(auditEvents.items.map((event) => event.action)).toContain('run.audit.read');
  });

  it('exports Prometheus-style runtime metrics for standalone operations', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-http-metrics-'));
    tempDirs.push(rootDir);

    const store = new SqliteJobStore(join(rootDir, 'jobs.sqlite'));
    closables.push(store);
    await store.initialize();

    const observability = new PrometheusRuntimeObservability();
    const service = new ConversationIntelligenceService({
      store,
      observability,
      engine: new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
        overallEndUserSentiment: {
          polarity: 'NEGATIVE',
          intensity: 0.4,
          confidence: 0.94,
          rationale: 'Metrics export test.',
        },
        aspectSentiments: [],
        canonicalEvents: [],
        canonicalKeyMoments: [],
        summary: 'Metrics export test.',
        review: {
          state: 'VERIFIED',
          reasons: [],
          comments: [],
          history: [],
        },
      })),
      clock: () => new Date('2026-03-28T00:00:00.000Z'),
    });

    const worker = new AnalysisWorker({
      service,
      workerId: 'metrics-worker',
      pollIntervalMs: 10,
    });
    workers.push(worker);
    worker.start();

    const server = await startConversationIntelligenceServer(service, {
      port: 0,
      metrics: {
        exporter: observability,
      },
    });
    servers.push(server);

    const baseUrl = getBaseUrl(server);

    const queueResponse = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        transcript: transcriptFixture,
        tenantPack: tenantPackFixture,
      }),
    });

    expect(queueResponse.status).toBe(202);
    const queuedRun = await queueResponse.json();
    const completedRun = await waitForCompletedJob(baseUrl, queuedRun.jobId, {});
    expect(completedRun.status).toBe('COMPLETED');

    const metricsResponse = await fetch(`${baseUrl}/metrics`);
    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.headers.get('content-type')).toContain('text/plain');

    const metricsText = await metricsResponse.text();
    expect(metricsText).toContain('conversation_intelligence_jobs_queued_total');
    expect(metricsText).toContain('conversation_intelligence_jobs_completed_total');
    expect(metricsText).toContain('conversation_intelligence_engine_calls_total');
    expect(metricsText).toContain('conversation_intelligence_span_duration_ms_bucket');
  });

  it('serves schema metadata and tenant-pack admin endpoints', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-http-tenant-pack-admin-'));
    tempDirs.push(rootDir);

    const store = new SqliteJobStore(join(rootDir, 'jobs.sqlite'));
    closables.push(store);
    await store.initialize();

    const tenantPacks = new FileTenantPackRegistry(join(rootDir, 'tenant-packs'), () => new Date('2026-03-28T00:00:00.000Z'));
    await tenantPacks.initialize();
    const tenantAdminConfigs = new FileTenantAdminConfigRegistry(join(rootDir, 'tenant-admin'), () => new Date('2026-03-28T00:00:00.000Z'));
    await tenantAdminConfigs.initialize();
    await tenantAdminConfigs.set({
      tenantId: tenantPackFixture.tenantId,
      useCase: tenantPackFixture.useCase,
      reviewWorkflow: {
        sla: {
          pendingTargetMinutes: 12,
          assignedTargetMinutes: 4,
        },
        assignment: {
          mode: 'AUTO_ASSIGN_SELF',
          requireAssignmentBeforeDecision: true,
        },
      },
      canaryAutomation: {
        enabled: true,
        minimumIntervalMinutes: 1,
        evaluationWindowHours: 24,
        applyResult: true,
      },
    });

    const service = new ConversationIntelligenceService({
      store,
      engine: new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
        overallEndUserSentiment: null,
        aspectSentiments: [],
        canonicalEvents: [],
        canonicalKeyMoments: [],
        summary: 'tenant-pack admin test',
        review: {
          state: 'VERIFIED',
          reasons: [],
          comments: [],
          history: [],
        },
      })),
      tenantAdminConfigs,
    });

    const server = await startConversationIntelligenceServer(service, {
      port: 0,
      clock: () => new Date('2026-03-28T00:45:00.000Z'),
      auth: {
        mode: 'api_key',
        apiKeys: [
          {
            token: 'token-pack-admin',
            tenantId: tenantPackFixture.tenantId,
            principalId: 'pack_admin',
            principalType: 'USER',
          },
        ],
      },
      tenantPacks,
      tenantAdminConfigs,
    });
    servers.push(server);

    const baseUrl = getBaseUrl(server);
    const authHeaders = {
      authorization: 'Bearer token-pack-admin',
      'content-type': 'application/json',
    };

    const schemaResponse = await fetch(`${baseUrl}/v1/schema/v1`, {
      headers: {
        authorization: 'Bearer token-pack-admin',
      },
    });
    expect(schemaResponse.status).toBe(200);
    const schemaBody = await schemaResponse.json();
    expect(schemaBody.version).toBe('v1');
    expect(Object.keys(schemaBody.schemas)).toEqual(expect.arrayContaining([
      'analysisRequest',
      'conversationAnalysis',
      'tenantPack',
      'tenantAdminConfigUpdateRequest',
      'reviewDecisionRequest',
      'reviewAssignmentRequest',
      'reviewCommentRequest',
      'tenantPackPublishRequest',
      'tenantPackApproveRequest',
      'tenantPackCommentRequest',
      'tenantPackAutoEvaluateCanaryRequest',
      'tenantPackEvaluateCanaryRequest',
      'reviewedRunExportRefreshRequest',
      'modelValidationThresholdRecommendationRequest',
      'modelValidationThresholdApplyRequest',
    ]));

    const adminConfigResponse = await fetch(`${baseUrl}/v1/tenant-admin/config?useCase=${encodeURIComponent(tenantPackFixture.useCase)}`, {
      headers: {
        authorization: 'Bearer token-pack-admin',
      },
    });
    expect(adminConfigResponse.status).toBe(200);
    const adminConfigBody = await adminConfigResponse.json();
    expect(adminConfigBody.config.reviewWorkflow.sla.pendingTargetMinutes).toBe(12);
    expect(adminConfigBody.config.reviewWorkflow.assignment.mode).toBe('AUTO_ASSIGN_SELF');

    const initialActiveResponse = await fetch(`${baseUrl}/v1/tenant-packs/active?useCase=${encodeURIComponent(tenantPackFixture.useCase)}`, {
      headers: {
        authorization: 'Bearer token-pack-admin',
      },
    });
    expect(initialActiveResponse.status).toBe(200);
    const initialActiveBody = await initialActiveResponse.json();
    expect(initialActiveBody.activePack).toBeNull();
    expect(initialActiveBody.availableVersions).toEqual([]);
    expect(initialActiveBody.releases).toEqual([]);

    const validateResponse = await fetch(`${baseUrl}/v1/tenant-packs/validate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        tenantPack: tenantPackFixture,
      }),
    });
    expect(validateResponse.status).toBe(200);
    const validateBody = await validateResponse.json();
    expect(validateBody.valid).toBe(true);
    expect(validateBody.compiledPack.packVersion).toBe(tenantPackFixture.packVersion);

    const previewResponse = await fetch(`${baseUrl}/v1/tenant-packs/preview`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        tenantPack: {
          ...tenantPackFixture,
          packVersion: 'support-preview',
        },
      }),
    });
    expect(previewResponse.status).toBe(200);
    const previewBody = await previewResponse.json();
    expect(previewBody.compiledPack.packVersion).toBe('support-preview');

    const publishV1Response = await fetch(`${baseUrl}/v1/tenant-packs/publish`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        tenantPack: tenantPackFixture,
      }),
    });
    expect(publishV1Response.status).toBe(200);
    const publishV1Body = await publishV1Response.json();
    expect(publishV1Body.activeVersion).toBe(tenantPackFixture.packVersion);
    expect(publishV1Body.availableVersions).toEqual([tenantPackFixture.packVersion]);
    expect(publishV1Body.release.status).toBe('ACTIVE');

    const activeAfterPublishResponse = await fetch(`${baseUrl}/v1/tenant-packs/active?useCase=${encodeURIComponent(tenantPackFixture.useCase)}`, {
      headers: {
        authorization: 'Bearer token-pack-admin',
      },
    });
    expect(activeAfterPublishResponse.status).toBe(200);
    const activeAfterPublishBody = await activeAfterPublishResponse.json();
    expect(activeAfterPublishBody.activeVersion).toBe(tenantPackFixture.packVersion);
    expect(activeAfterPublishBody.availableVersions).toEqual([tenantPackFixture.packVersion]);
    expect(activeAfterPublishBody.releases[0].status).toBe('ACTIVE');

    const v2Pack = {
      ...tenantPackFixture,
      packVersion: 'support-v2',
      policyDigest: [...tenantPackFixture.policyDigest, 'Route chronically delayed refunds to supervisor review.'],
    };

    const publishV2Response = await fetch(`${baseUrl}/v1/tenant-packs/publish`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        tenantPack: v2Pack,
        release: {
          mode: 'APPROVAL_REQUIRED',
          approvalsRequired: 1,
          canaryPercentage: 10,
          canaryPolicy: {
            minimumSampleSize: 2,
            maximumFailureRate: 0.1,
            maximumReviewRate: 0.5,
            maximumUncertainRate: 0.5,
          },
          note: 'Require approval before rollout.',
        },
      }),
    });
    expect(publishV2Response.status).toBe(200);
    const publishV2Body = await publishV2Response.json();
    expect(publishV2Body.activeVersion).toBe(tenantPackFixture.packVersion);
    expect(publishV2Body.release.status).toBe('PENDING_APPROVAL');
    expect(publishV2Body.availableVersions).toEqual([tenantPackFixture.packVersion, 'support-v2']);

    const approveV2Response = await fetch(`${baseUrl}/v1/tenant-packs/approve`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        tenantId: tenantPackFixture.tenantId,
        useCase: tenantPackFixture.useCase,
        targetPackVersion: 'support-v2',
        note: 'Approved for canary.',
      }),
    });
    expect(approveV2Response.status).toBe(200);
    const approveV2Body = await approveV2Response.json();
    expect(approveV2Body.activeVersion).toBe(tenantPackFixture.packVersion);
    expect(approveV2Body.release.status).toBe('CANARY');
    expect(approveV2Body.release.approvals).toHaveLength(1);

    const commentV2Response = await fetch(`${baseUrl}/v1/tenant-packs/comment`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        tenantId: tenantPackFixture.tenantId,
        useCase: tenantPackFixture.useCase,
        targetPackVersion: 'support-v2',
        comment: 'Watching review-rate regression before promotion.',
      }),
    });
    expect(commentV2Response.status).toBe(200);
    const commentV2Body = await commentV2Response.json();
    expect(commentV2Body.release.history.map((entry: { kind: string }) => entry.kind)).toContain('COMMENTED');

    const evaluateV2Response = await fetch(`${baseUrl}/v1/tenant-packs/evaluate-canary`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        tenantId: tenantPackFixture.tenantId,
        useCase: tenantPackFixture.useCase,
        targetPackVersion: 'support-v2',
        metrics: {
          sampleSize: 25,
          failureRate: 0.02,
          reviewRate: 0.1,
          uncertainRate: 0.02,
          averageScore100: 64,
        },
        applyResult: false,
        note: 'Automated canary check passed but leave promotion manual.',
      }),
    });
    expect(evaluateV2Response.status).toBe(200);
    const evaluateV2Body = await evaluateV2Response.json();
    expect(evaluateV2Body.evaluation.decision).toBe('PASS');
    expect(evaluateV2Body.release.status).toBe('CANARY');
    expect(evaluateV2Body.release.canary.evaluations).toHaveLength(1);

    await store.createJob(analysisJobRecordSchema.parse({
      jobId: 'job_canary_auto_completed_1',
      status: 'COMPLETED',
      tenantId: tenantPackFixture.tenantId,
      conversationId: 'conversation_canary_auto_completed_1',
      useCase: tenantPackFixture.useCase,
      createdAt: '2026-03-28T00:30:00.000Z',
      updatedAt: '2026-03-28T00:35:00.000Z',
      request: {
        transcript: transcriptFixture,
        tenantPack: v2Pack,
        piiConfig: {
          enabled: true,
          maskDisplayNames: false,
          customRegexRules: [],
        },
      },
      result: conversationAnalysisSchema.parse({
        jobId: 'job_canary_auto_completed_1',
        tenantId: tenantPackFixture.tenantId,
        conversationId: 'conversation_canary_auto_completed_1',
        useCase: tenantPackFixture.useCase,
        analysisScope: {
          sentimentRoles: ['END_USER'],
          keyMomentRoles: ['END_USER'],
        },
        speakerSummary: {
          resolvedRoles: ['END_USER', 'AGENT'],
          confidence: 0.95,
        },
        overallEndUserSentiment: {
          polarity: 'POSITIVE',
          intensity: 0.44,
          confidence: 0.9,
          rationale: 'Synthetic canary auto evaluation test.',
          score: {
            method: 'derived_v1',
            score100: 72,
            score5: 4,
          },
        },
        aspectSentiments: [],
        canonicalEvents: [],
        canonicalKeyMoments: [],
        tenantMappedEvents: [],
        speakerAssignments: [],
        review: {
          state: 'VERIFIED',
          reasons: [],
          comments: [],
          history: [],
        },
        summary: 'Synthetic canary auto evaluation test.',
        trace: {
          engine: 'rules',
          model: 'test-model',
          packVersion: 'support-v2',
          promptVersion: 'test-prompt',
          generatedAt: '2026-03-28T00:35:00.000Z',
        },
      }),
    }));

    await store.createJob(analysisJobRecordSchema.parse({
      jobId: 'job_canary_auto_completed_2',
      status: 'COMPLETED',
      tenantId: tenantPackFixture.tenantId,
      conversationId: 'conversation_canary_auto_completed_2',
      useCase: tenantPackFixture.useCase,
      createdAt: '2026-03-28T00:31:00.000Z',
      updatedAt: '2026-03-28T00:36:00.000Z',
      request: {
        transcript: transcriptFixture,
        tenantPack: v2Pack,
        piiConfig: {
          enabled: true,
          maskDisplayNames: false,
          customRegexRules: [],
        },
      },
      result: conversationAnalysisSchema.parse({
        jobId: 'job_canary_auto_completed_2',
        tenantId: tenantPackFixture.tenantId,
        conversationId: 'conversation_canary_auto_completed_2',
        useCase: tenantPackFixture.useCase,
        analysisScope: {
          sentimentRoles: ['END_USER'],
          keyMomentRoles: ['END_USER'],
        },
        speakerSummary: {
          resolvedRoles: ['END_USER', 'AGENT'],
          confidence: 0.95,
        },
        overallEndUserSentiment: {
          polarity: 'POSITIVE',
          intensity: 0.4,
          confidence: 0.9,
          rationale: 'Synthetic canary auto evaluation test.',
          score: {
            method: 'derived_v1',
            score100: 70,
            score5: 4,
          },
        },
        aspectSentiments: [],
        canonicalEvents: [],
        canonicalKeyMoments: [],
        tenantMappedEvents: [],
        speakerAssignments: [],
        review: {
          state: 'VERIFIED',
          reasons: [],
          comments: [],
          history: [],
        },
        summary: 'Synthetic canary auto evaluation test.',
        trace: {
          engine: 'rules',
          model: 'test-model',
          packVersion: 'support-v2',
          promptVersion: 'test-prompt',
          generatedAt: '2026-03-28T00:36:00.000Z',
        },
      }),
    }));

    const updateAdminConfigResponse = await fetch(`${baseUrl}/v1/tenant-admin/config`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        config: {
          tenantId: tenantPackFixture.tenantId,
          useCase: tenantPackFixture.useCase,
          reviewWorkflow: adminConfigBody.config.reviewWorkflow,
          canaryAutomation: {
            enabled: true,
            minimumIntervalMinutes: 1,
            evaluationWindowHours: 24,
            applyResult: true,
          },
        },
      }),
    });
    expect(updateAdminConfigResponse.status).toBe(200);

    const autoEvaluateResponse = await fetch(`${baseUrl}/v1/tenant-packs/auto-evaluate-canary`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        tenantId: tenantPackFixture.tenantId,
        useCase: tenantPackFixture.useCase,
        targetPackVersion: 'support-v2',
        force: true,
      }),
    });
    expect(autoEvaluateResponse.status).toBe(200);
    const autoEvaluateBody = await autoEvaluateResponse.json();
    expect(autoEvaluateBody.attempted).toBe(true);
    expect(autoEvaluateBody.result.evaluation.metrics.sampleSize).toBeGreaterThanOrEqual(2);
    expect(autoEvaluateBody.result.release.status).toBe('ACTIVE');

    const rollbackResponse = await fetch(`${baseUrl}/v1/tenant-packs/rollback`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        tenantId: tenantPackFixture.tenantId,
        useCase: tenantPackFixture.useCase,
        targetPackVersion: tenantPackFixture.packVersion,
      }),
    });
    expect(rollbackResponse.status).toBe(200);
    const rollbackBody = await rollbackResponse.json();
    expect(rollbackBody.activeVersion).toBe(tenantPackFixture.packVersion);
    expect(rollbackBody.previousVersion).toBe('support-v2');

    const activePack = await tenantPacks.getActive(tenantPackFixture.tenantId, tenantPackFixture.useCase);
    expect(activePack?.packVersion).toBe(tenantPackFixture.packVersion);

    const auditEvents = await service.listAuditEvents(tenantPackFixture.tenantId);
    expect(auditEvents.items.map((event) => event.action)).toContain('schema.read');
    expect(auditEvents.items.map((event) => event.action)).toContain('tenant_pack.read');
    expect(auditEvents.items.map((event) => event.action)).toContain('tenant_pack.validated');
    expect(auditEvents.items.map((event) => event.action)).toContain('tenant_pack.previewed');
    expect(auditEvents.items.map((event) => event.action)).toContain('tenant_pack.published');
    expect(auditEvents.items.map((event) => event.action)).toContain('tenant_pack.approved');
    expect(auditEvents.items.map((event) => event.action)).toContain('tenant_pack.commented');
    expect(auditEvents.items.map((event) => event.action)).toContain('tenant_admin.read');
    expect(auditEvents.items.map((event) => event.action)).toContain('tenant_admin.updated');
    expect(auditEvents.items.map((event) => event.action)).toContain('tenant_pack.canary_auto_evaluated');
    expect(auditEvents.items.map((event) => event.action)).toContain('tenant_pack.canary_evaluated');
    expect(auditEvents.items.map((event) => event.action)).toContain('tenant_pack.rolled_back');
  });
});
