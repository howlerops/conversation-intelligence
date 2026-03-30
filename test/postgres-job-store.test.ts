import { afterEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import {
  PostgresJobStore,
  analyzeConversation,
} from '../src';
import { StubCanonicalAnalysisEngine } from '../src/rlm/engine';
import { canonicalExtractionSchema } from '../src/contracts/analysis';
import { AnalysisJobRecord } from '../src/contracts/jobs';
import { TenantPackDraft, TranscriptInputDraft } from '../src/contracts';
import transcriptFixture from '../fixtures/transcript.support.basic.json';
import tenantPackFixture from '../fixtures/tenant-pack.support.acme.json';

type ClosablePool = {
  end(): Promise<void>;
};

async function createCompletedResult() {
  return analyzeConversation(
    transcriptFixture as TranscriptInputDraft,
    tenantPackFixture as TenantPackDraft,
    {
      engine: new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
        overallEndUserSentiment: {
          polarity: 'NEGATIVE',
          intensity: 0.8,
          confidence: 0.92,
          rationale: 'Customer frustration is explicit.',
        },
        aspectSentiments: [],
        canonicalEvents: [],
        canonicalKeyMoments: [],
        summary: 'Completed review-required analysis.',
        review: {
          state: 'NEEDS_REVIEW',
          reasons: ['manual check required'],
          comments: [],
          history: [],
        },
      })),
      jobId: 'job_pg_review',
      now: new Date('2026-03-28T00:00:00.000Z'),
    },
  );
}

describe('PostgresJobStore', () => {
  const pools: ClosablePool[] = [];

  afterEach(async () => {
    await Promise.allSettled(pools.map(async (pool) => pool.end()));
    pools.length = 0;
  });

  it('persists jobs, run events, audit events, and review queue entries via Postgres semantics', async () => {
    const db = newDb();
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const store = new PostgresJobStore({
      pool,
    });
    await store.initialize();

    const queuedJob: AnalysisJobRecord = {
      jobId: 'job_pg_queued',
      status: 'QUEUED',
      tenantId: 'tenant_support_acme',
      conversationId: 'conv_pg_queued',
      useCase: 'support',
      createdAt: '2026-03-28T00:00:00.000Z',
      updatedAt: '2026-03-28T00:00:00.000Z',
    };

    const completedResult = await createCompletedResult();
    const completedJob: AnalysisJobRecord = {
      jobId: 'job_pg_review',
      status: 'COMPLETED',
      tenantId: 'tenant_support_acme',
      conversationId: 'conv_pg_review',
      useCase: 'support',
      createdAt: '2026-03-28T00:01:00.000Z',
      updatedAt: '2026-03-28T00:02:00.000Z',
      result: completedResult,
    };

    await store.createJob(queuedJob);
    await store.createJob(completedJob);

    const claimed = await store.claimNextQueuedJob('worker_pg', '2026-03-28T00:00:30.000Z');
    expect(claimed?.status).toBe('RUNNING');
    expect(claimed?.jobId).toBe('job_pg_queued');

    await store.appendRunEvent({
      eventId: 'evt_pg_1',
      runId: completedJob.jobId,
      tenantId: completedJob.tenantId,
      type: 'RUN_COMPLETED',
      createdAt: '2026-03-28T00:02:00.000Z',
      summary: 'Run completed.',
      metadata: {},
    });

    await store.appendAuditEvent({
      auditId: 'audit_pg_1',
      tenantId: completedJob.tenantId,
      action: 'run.read',
      resourceType: 'run',
      resourceId: completedJob.jobId,
      occurredAt: '2026-03-28T00:02:01.000Z',
      actor: {
        authMode: 'api_key',
        principalId: 'svc_test',
        principalType: 'API_KEY',
        tenantId: completedJob.tenantId,
        scopes: ['runs:read'],
      },
      metadata: {},
    });

    const jobs = await store.listJobs({ tenantId: 'tenant_support_acme' });
    expect(jobs).toHaveLength(2);

    const runEvents = await store.listRunEvents(completedJob.jobId);
    expect(runEvents.events).toHaveLength(1);
    expect(runEvents.events[0].type).toBe('RUN_COMPLETED');

    const auditEvents = await store.listAuditEvents({ tenantId: 'tenant_support_acme' });
    expect(auditEvents.items).toHaveLength(1);
    expect(auditEvents.items[0].resourceId).toBe(completedJob.jobId);

    const reviewQueue = await store.listReviewQueue('tenant_support_acme');
    expect(reviewQueue.items).toHaveLength(1);
    expect(reviewQueue.items[0].jobId).toBe(completedJob.jobId);
  });
});
