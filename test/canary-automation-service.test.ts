import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CanaryAutomationService,
  ConversationIntelligenceService,
  FileTenantAdminConfigRegistry,
  FileTenantPackRegistry,
  SqliteJobStore,
  TenantPackDraft,
  analysisJobRecordSchema,
  canonicalExtractionSchema,
  conversationAnalysisSchema,
} from '../src';
import { StubCanonicalAnalysisEngine } from '../src/rlm/engine';
import tenantPackFixture from '../fixtures/tenant-pack.support.acme.json';
import transcriptFixture from '../fixtures/transcript.support.basic.json';

function buildCompletedAnalysis(jobId: string, packVersion: string, score100: number, reviewState: 'VERIFIED' | 'NEEDS_REVIEW' | 'UNCERTAIN') {
  const score5 = Math.min(5, Math.floor(Math.max(score100 - 1, 0) / 20) + 1);
  return conversationAnalysisSchema.parse({
    jobId,
    tenantId: tenantPackFixture.tenantId,
    conversationId: `${jobId}_conversation`,
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
      polarity: score100 < 50 ? 'NEGATIVE' : score100 > 50 ? 'POSITIVE' : 'NEUTRAL',
      intensity: Math.abs(score100 - 50) / 50,
      confidence: 0.92,
      rationale: 'Synthetic canary automation test sentiment.',
      score: {
        method: 'derived_v1',
        score100,
        score5,
      },
    },
    aspectSentiments: [],
    canonicalEvents: [],
    canonicalKeyMoments: [],
    tenantMappedEvents: [],
    speakerAssignments: [],
    review: {
      state: reviewState,
      reasons: reviewState === 'VERIFIED' ? [] : ['Synthetic review state for canary metrics.'],
      comments: [],
      history: [],
    },
    summary: 'Synthetic canary automation run.',
    trace: {
      engine: 'rules',
      model: 'test-model',
      packVersion,
      promptVersion: 'test-prompt',
      generatedAt: '2026-03-28T00:00:00.000Z',
    },
  });
}

describe('CanaryAutomationService', () => {
  const tempDirs: string[] = [];
  const closables: Array<{ close(): void }> = [];

  afterEach(async () => {
    await Promise.allSettled(closables.map(async (closable) => closable.close()));
    closables.length = 0;
    await Promise.allSettled(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('computes live canary metrics from run history and auto-promotes passing releases', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-canary-automation-'));
    tempDirs.push(rootDir);

    const store = new SqliteJobStore(join(rootDir, 'jobs.sqlite'));
    closables.push(store);
    await store.initialize();

    const tenantPacks = new FileTenantPackRegistry(join(rootDir, 'tenant-packs'), () => new Date('2026-03-28T00:00:00.000Z'));
    await tenantPacks.initialize();
    const tenantAdminConfigs = new FileTenantAdminConfigRegistry(join(rootDir, 'tenant-admin'), () => new Date('2026-03-28T02:00:00.000Z'));
    await tenantAdminConfigs.initialize();

    const service = new ConversationIntelligenceService({
      store,
      engine: new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
        overallEndUserSentiment: null,
        aspectSentiments: [],
        canonicalEvents: [],
        canonicalKeyMoments: [],
        summary: 'unused',
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

    const v1 = tenantPackFixture as TenantPackDraft;
    const v2 = {
      ...tenantPackFixture,
      packVersion: 'support-v2',
      policyDigest: [...tenantPackFixture.policyDigest, 'Canary automation validation rule.'],
    } as TenantPackDraft;

    await tenantPacks.publish({ tenantPack: v1 });
    await tenantPacks.publish({
      tenantPack: v2,
      release: {
        mode: 'CANARY',
        canaryPercentage: 20,
      },
    });

    await tenantAdminConfigs.set({
      tenantId: tenantPackFixture.tenantId,
      useCase: tenantPackFixture.useCase,
      reviewWorkflow: {
        sla: {
          pendingTargetMinutes: 20,
          assignedTargetMinutes: 10,
        },
        assignment: {
          mode: 'AUTO_ASSIGN_SELF',
          requireAssignmentBeforeDecision: true,
        },
      },
      canaryAutomation: {
        enabled: true,
        minimumIntervalMinutes: 5,
        evaluationWindowHours: 24,
        applyResult: true,
      },
    });

    const jobs = [
      ...Array.from({ length: 24 }, (_, index) => ({
        jobId: `completed_${index}`,
        status: 'COMPLETED' as const,
        result: buildCompletedAnalysis(`completed_${index}`, 'support-v2', 70 + (index % 5), index < 2 ? 'NEEDS_REVIEW' : 'VERIFIED'),
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        jobId: `uncertain_${index}`,
        status: 'COMPLETED' as const,
        result: buildCompletedAnalysis(`uncertain_${index}`, 'support-v2', 66 + index, 'UNCERTAIN'),
      })),
      ...Array.from({ length: 2 }, (_, index) => ({
        jobId: `failed_${index}`,
        status: 'FAILED' as const,
        result: undefined,
      })),
    ];

    for (const job of jobs) {
      await store.createJob(analysisJobRecordSchema.parse({
        jobId: job.jobId,
        status: job.status,
        tenantId: tenantPackFixture.tenantId,
        conversationId: `${job.jobId}_conversation`,
        useCase: tenantPackFixture.useCase,
        createdAt: '2026-03-28T01:00:00.000Z',
        updatedAt: '2026-03-28T01:30:00.000Z',
        request: {
          transcript: transcriptFixture,
          tenantPack: v2,
          piiConfig: {
            enabled: true,
            maskDisplayNames: false,
            customRegexRules: [],
          },
        },
        result: job.result,
        error: job.status === 'FAILED'
          ? {
            message: 'Synthetic failure for canary metric coverage.',
          }
          : undefined,
      }));
    }

    const automation = new CanaryAutomationService({
      service,
      tenantPacks,
      tenantAdminConfigs,
      clock: () => new Date('2026-03-28T02:00:00.000Z'),
    });

    const response = await automation.evaluateScope({
      tenantId: tenantPackFixture.tenantId,
      useCase: tenantPackFixture.useCase,
      targetPackVersion: 'support-v2',
      force: true,
    });

    expect(response.attempted).toBe(true);
    expect(response.result?.evaluation.decision).toBe('PASS');
    expect(response.result?.evaluation.metrics.sampleSize).toBe(29);
    expect(response.result?.evaluation.metrics.failedRuns).toBe(2);
    expect(response.result?.evaluation.metrics.completedRuns).toBe(27);
    expect(response.result?.evaluation.metrics.reviewCount).toBe(2);
    expect(response.result?.evaluation.metrics.uncertainCount).toBe(3);
    expect(response.result?.release.status).toBe('ACTIVE');

    const active = await tenantPacks.getActive(tenantPackFixture.tenantId, tenantPackFixture.useCase);
    expect(active?.packVersion).toBe('support-v2');
  });
});
