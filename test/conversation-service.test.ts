import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AnalysisWorker,
  ConversationIntelligenceService,
  FileTenantAdminConfigRegistry,
  InMemoryRuntimeObservability,
  SqliteJobStore,
} from '../src';
import { StubCanonicalAnalysisEngine } from '../src/rlm/engine';
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
    const observability = new InMemoryRuntimeObservability();

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
          comments: [],
          history: [],
        },
      })),
      clock: () => new Date('2026-03-28T00:00:00.000Z'),
      piiMaskers: [createAccountMasker()],
      observability,
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
      const runEvents = await service.listRunEvents(queued.jobId);
      expect(runEvents.events.map((event) => event.type)).toEqual([
        'RUN_CREATED',
        'PII_MASKED',
        'RUN_CLAIMED',
        'LLM_STARTED',
        'LLM_COMPLETED',
        'REVIEW_REQUIRED',
        'RUN_COMPLETED',
      ]);

      const reviewQueue = await service.listReviewQueue();
      expect(reviewQueue.items.length).toBe(1);
      expect(reviewQueue.items[0].jobId).toBe(queued.jobId);
      const reviewAnalytics = await service.getReviewAnalytics();
      expect(reviewAnalytics.pendingCount).toBe(1);
      expect(reviewAnalytics.sla.pendingTargetMinutes).toBeGreaterThan(0);

      const commented = await service.recordReviewComment(queued.jobId, {
        comment: 'Needs analyst follow-up before customer-facing use.',
      }, {
        authMode: 'api_key',
        principalId: 'analyst_service',
        principalType: 'SERVICE',
        tenantId: 'tenant_acme',
        scopes: [],
      });
      expect(commented.result?.review.comments).toHaveLength(1);
      expect(observability.metrics.some((metric) => metric.name === 'conversation_intelligence.jobs.queued')).toBe(true);
      expect(observability.metrics.some((metric) => metric.name === 'conversation_intelligence.jobs.completed')).toBe(true);
      expect(observability.metrics.some((metric) => metric.name === 'conversation_intelligence.review.comments')).toBe(true);
      expect(observability.spans.some((span) => span.name === 'conversation_intelligence.process_claimed_job')).toBe(true);
    } finally {
      await worker.stop();
    }
  });

  it('uses tenant admin config for review SLA and assignment policy', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-service-admin-config-'));
    tempDirs.push(rootDir);

    const store = new SqliteJobStore(join(rootDir, 'jobs.sqlite'));
    closables.push(store);
    await store.initialize();

    const tenantAdminConfigs = new FileTenantAdminConfigRegistry(
      join(rootDir, 'tenant-admin'),
      () => new Date('2026-03-28T01:30:00.000Z'),
    );
    await tenantAdminConfigs.initialize();
    await tenantAdminConfigs.set({
      tenantId: 'tenant_acme',
      useCase: 'support',
      reviewWorkflow: {
        sla: {
          pendingTargetMinutes: 15,
          assignedTargetMinutes: 5,
        },
        assignment: {
          mode: 'AUTO_ASSIGN_SELF',
          requireAssignmentBeforeDecision: true,
        },
      },
      canaryAutomation: {
        enabled: false,
        minimumIntervalMinutes: 60,
        evaluationWindowHours: 24,
        applyResult: false,
      },
    });

    const service = new ConversationIntelligenceService({
      store,
      engine: new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
        overallEndUserSentiment: {
          polarity: 'NEGATIVE',
          intensity: 0.7,
          confidence: 0.91,
          rationale: 'Admin config review test.',
        },
        aspectSentiments: [],
        canonicalEvents: [],
        canonicalKeyMoments: [],
        summary: 'Admin config review test.',
        review: {
          state: 'NEEDS_REVIEW',
          reasons: ['Confidence is borderline.'],
          comments: [],
          history: [],
        },
      })),
      tenantAdminConfigs,
      clock: () => new Date('2026-03-28T01:30:00.000Z'),
    });

    const worker = new AnalysisWorker({
      service,
      pollIntervalMs: 10,
      workerId: 'worker_admin_config',
    });
    worker.start();

    try {
      const queued = await service.submitJob({
        transcript: transcriptWithAdminNote as TranscriptInputDraft,
        tenantPack: tenantPackFixture as TenantPackDraft,
      });

      const completed = await waitForCompletion(service, queued.jobId);
      expect(completed?.status).toBe('COMPLETED');
      expect(completed?.result?.review.state).toBe('NEEDS_REVIEW');

      const reviewQueue = await service.listReviewQueue('tenant_acme');
      expect(reviewQueue.items).toHaveLength(1);
      expect(reviewQueue.items[0].policy?.pendingTargetMinutes).toBe(15);
      expect(reviewQueue.items[0].policy?.assignedTargetMinutes).toBe(5);
      expect(reviewQueue.items[0].policy?.assignmentMode).toBe('AUTO_ASSIGN_SELF');
      expect(reviewQueue.items[0].policy?.requireAssignmentBeforeDecision).toBe(true);

      const analytics = await service.getReviewAnalytics('tenant_acme');
      expect(analytics.sla.configuredPolicies).toEqual([
        expect.objectContaining({
          tenantId: 'tenant_acme',
          useCase: 'support',
          pendingTargetMinutes: 15,
          assignedTargetMinutes: 5,
          assignmentMode: 'AUTO_ASSIGN_SELF',
          requireAssignmentBeforeDecision: true,
          runCount: 1,
        }),
      ]);

      const decided = await service.recordReviewDecision(queued.jobId, {
        decision: 'VERIFY',
        sentimentLabel: {
          score100: 32,
          correctionApplied: true,
          note: 'Analyst calibrated the final customer sentiment.',
        },
      }, {
        authMode: 'api_key',
        principalId: 'analyst_1',
        principalType: 'USER',
        tenantId: 'tenant_acme',
        scopes: [],
      });

      expect(decided.result?.review.assignment?.assigneeId).toBe('analyst_1');
      expect(decided.result?.review.resolution?.decision).toBe('VERIFY');
      expect(decided.result?.review.analystSentiment?.score100).toBe(32);
      expect(decided.result?.review.analystSentiment?.score5).toBe(2);
      expect(decided.result?.review.analystSentiment?.reviewedById).toBe('analyst_1');

      const runEvents = await service.listRunEvents(queued.jobId);
      expect(runEvents.events.map((event) => event.type)).toEqual(expect.arrayContaining([
        'ANALYST_ASSIGNED',
        'ANALYST_REVIEW_RECORDED',
      ]));
    } finally {
      await worker.stop();
    }
  });

  it('applies tenant sentiment scoring calibration by engagement type', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-service-sentiment-calibration-'));
    tempDirs.push(rootDir);

    const store = new SqliteJobStore(join(rootDir, 'jobs.sqlite'));
    closables.push(store);
    await store.initialize();

    const tenantAdminConfigs = new FileTenantAdminConfigRegistry(
      join(rootDir, 'tenant-admin'),
      () => new Date('2026-03-28T02:00:00.000Z'),
    );
    await tenantAdminConfigs.initialize();
    await tenantAdminConfigs.set({
      tenantId: 'tenant_acme',
      useCase: 'support',
      reviewWorkflow: {
        sla: {
          pendingTargetMinutes: 15,
          assignedTargetMinutes: 5,
        },
        assignment: {
          mode: 'MANUAL',
          requireAssignmentBeforeDecision: false,
        },
      },
      canaryAutomation: {
        enabled: false,
        minimumIntervalMinutes: 60,
        evaluationWindowHours: 24,
        applyResult: false,
      },
      validationMonitoring: {
        enabled: false,
        minimumIntervalMinutes: 1440,
        evaluationWindowHours: 168,
        thresholds: {
          minimumReviewedSampleSize: 10,
          maximumFailureRate: 0.1,
          maximumReviewRate: 0.35,
          maximumUncertainRate: 0.15,
          minimumSchemaValidRate: 0.98,
          maximumAverageDeltaScore100: 5,
          maximumAverageDeltaScore5: 0.5,
          minimumExactScore5MatchRate: 0.75,
          minimumWithinFivePointsRate: 0.95,
          maximumAverageProcessingDurationMs: 900000,
          maximumP95ProcessingDurationMs: 1800000,
          byEngagementType: {},
          byQueue: {},
          byTranscriptLengthBucket: {},
        },
        recommendations: {
          autoApply: false,
          minimumIntervalMinutes: 1440,
          minimumRunCount: 50,
          minimumReviewedSampleSize: 20,
          minimumRunCountPerEngagementType: 15,
          minimumReviewedSampleSizePerEngagementType: 8,
          minimumRunCountPerQueue: 10,
          minimumReviewedSampleSizePerQueue: 5,
          minimumRunCountPerTranscriptLengthBucket: 10,
          minimumReviewedSampleSizePerTranscriptLengthBucket: 5,
        },
      },
      sentimentScoring: {
        enabled: true,
        defaultScore100Offset: 0,
        byEngagementType: {
          TICKET: 3,
        },
      },
    });

    const service = new ConversationIntelligenceService({
      store,
      engine: new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
        overallEndUserSentiment: {
          polarity: 'NEGATIVE',
          intensity: 0.52,
          confidence: 0.91,
          rationale: 'Ticket sentiment calibration test.',
        },
        aspectSentiments: [],
        canonicalEvents: [],
        canonicalKeyMoments: [],
        summary: 'Ticket sentiment calibration test.',
        review: {
          state: 'VERIFIED',
          reasons: [],
          comments: [],
          history: [],
        },
      })),
      tenantAdminConfigs,
      clock: () => new Date('2026-03-28T02:00:00.000Z'),
    });

    const transcript = structuredClone(transcriptWithAdminNote) as TranscriptInputDraft;
    transcript.metadata = {
      ...transcript.metadata,
      engagementType: 'TICKET',
    };

    const result = await service.analyzeNow({
      transcript,
      tenantPack: tenantPackFixture as TenantPackDraft,
    });

    expect(result.overallEndUserSentiment?.score).toEqual({
      method: 'derived_v1_calibrated',
      score100: 27,
      score5: 2,
      calibration: {
        score100Offset: 3,
        engagementType: 'TICKET',
      },
    });
  });
});
