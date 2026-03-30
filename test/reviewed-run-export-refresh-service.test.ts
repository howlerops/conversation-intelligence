import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConversationIntelligenceService,
  FileModelValidationReportStore,
  FileTenantAdminConfigRegistry,
  FileTenantPackRegistry,
  ModelValidationService,
  ReviewedRunExportRefreshService,
  SqliteJobStore,
  TenantPackDraft,
  analysisJobRecordSchema,
  canonicalExtractionSchema,
  conversationAnalysisSchema,
  reviewedRunExportManifestSchema,
} from '../src';
import { StubCanonicalAnalysisEngine } from '../src/rlm/engine';
import tenantPackFixture from '../fixtures/tenant-pack.support.acme.json';
import transcriptFixture from '../fixtures/transcript.support.basic.json';

function buildCompletedJob(updatedAt: string) {
  return analysisJobRecordSchema.parse({
    jobId: 'refresh-job-001',
    status: 'COMPLETED',
    tenantId: tenantPackFixture.tenantId,
    conversationId: transcriptFixture.conversationId,
    useCase: tenantPackFixture.useCase,
    createdAt: '2026-03-29T10:00:00.000Z',
    updatedAt,
    request: {
      transcript: transcriptFixture,
      tenantPack: tenantPackFixture,
      piiConfig: {
        enabled: true,
        maskDisplayNames: false,
        customRegexRules: [],
      },
    },
    result: conversationAnalysisSchema.parse({
      jobId: 'refresh-job-001',
      tenantId: tenantPackFixture.tenantId,
      conversationId: transcriptFixture.conversationId,
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
        polarity: 'NEGATIVE',
        intensity: 0.5,
        confidence: 0.92,
        rationale: 'Synthetic refresh test sentiment.',
        score: {
          method: 'derived_v1',
          score100: 30,
          score5: 2,
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
        resolution: {
          decision: 'VERIFY',
          resultingState: 'VERIFIED',
          decidedAt: updatedAt,
          actorId: 'analyst_1',
          actorType: 'USER',
        },
        analystSentiment: {
          score100: 28,
          score5: 2,
          correctionApplied: false,
          reviewedAt: updatedAt,
          reviewedById: 'analyst_1',
          reviewedByType: 'USER',
        },
      },
      summary: 'Synthetic reviewed export refresh test.',
      trace: {
        engine: 'rules',
        model: 'stub',
        packVersion: tenantPackFixture.packVersion,
        promptVersion: 'test-prompt',
        generatedAt: updatedAt,
      },
    }),
  });
}

describe('ReviewedRunExportRefreshService', () => {
  const tempDirs: string[] = [];
  const closables: Array<{ close(): void }> = [];

  afterEach(async () => {
    await Promise.allSettled(closables.map(async (closable) => closable.close()));
    closables.length = 0;
    await Promise.allSettled(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('writes manifest policy metadata and prunes old snapshots', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-reviewed-export-refresh-'));
    tempDirs.push(rootDir);

    const store = new SqliteJobStore(join(rootDir, 'jobs.sqlite'));
    closables.push(store);
    await store.initialize();
    await store.createJob(buildCompletedJob('2026-03-29T10:05:00.000Z'));

    const tenantPacks = new FileTenantPackRegistry(join(rootDir, 'tenant-packs'));
    await tenantPacks.initialize();
    await tenantPacks.publish({ tenantPack: tenantPackFixture as TenantPackDraft });

    const tenantAdminConfigs = new FileTenantAdminConfigRegistry(join(rootDir, 'tenant-admin'));
    await tenantAdminConfigs.initialize();
    await tenantAdminConfigs.set({
      tenantId: tenantPackFixture.tenantId,
      useCase: tenantPackFixture.useCase,
      reviewWorkflow: {
        sla: {
          pendingTargetMinutes: 60,
          assignedTargetMinutes: 30,
        },
        assignment: {
          mode: 'MANUAL',
          requireAssignmentBeforeDecision: false,
        },
      },
      canaryAutomation: {
        enabled: false,
        minimumIntervalMinutes: 60,
        evaluationWindowHours: 168,
        applyResult: false,
      },
      validationMonitoring: {
        enabled: true,
        minimumIntervalMinutes: 1440,
        evaluationWindowHours: 168,
        thresholds: {
          minimumReviewedSampleSize: 1,
          maximumFailureRate: 1,
          maximumReviewRate: 1,
          maximumUncertainRate: 1,
          minimumSchemaValidRate: 0,
          maximumAverageDeltaScore100: 100,
          maximumAverageDeltaScore5: 4,
          minimumExactScore5MatchRate: 0,
          minimumWithinFivePointsRate: 0,
          maximumAverageProcessingDurationMs: 100000,
          maximumP95ProcessingDurationMs: 100000,
          byEngagementType: {},
          byQueue: {},
          byTranscriptLengthBucket: {},
        },
        recommendations: {
          autoApply: false,
          minimumIntervalMinutes: 1440,
          minimumRunCount: 1,
          minimumReviewedSampleSize: 1,
          minimumRunCountPerEngagementType: 1,
          minimumReviewedSampleSizePerEngagementType: 1,
          minimumRunCountPerQueue: 1,
          minimumReviewedSampleSizePerQueue: 1,
          minimumRunCountPerTranscriptLengthBucket: 1,
          minimumReviewedSampleSizePerTranscriptLengthBucket: 1,
        },
        reviewedExports: {
          includeTranscript: false,
          requireAnalystSentiment: false,
          classification: 'INTERNAL',
          retentionDays: 30,
          maximumSnapshots: 1,
        },
        reviewedDatasetReadiness: {
          minimumRecordCount: 2,
          minimumAnalystSentimentCount: 2,
          byEngagementType: {},
          byQueue: {},
          byTranscriptLengthBucket: {},
        },
      },
      sentimentScoring: {
        enabled: false,
        defaultScore100Offset: 0,
        byEngagementType: {},
        byPolarity: {},
        byEngagementTypeAndPolarity: {},
      },
      updatedAt: '2026-03-29T10:10:00.000Z',
    });

    const reports = new FileModelValidationReportStore(join(rootDir, 'reports'));
    await reports.initialize();
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
    });
    const validation = new ModelValidationService({
      service,
      tenantPacks,
      tenantAdminConfigs,
      reportStore: reports,
      reviewedDataDir: join(rootDir, 'reviewed'),
    });

    let now = new Date('2026-03-29T11:00:00.000Z');
    const refresh = new ReviewedRunExportRefreshService({
      validation,
      tenantAdminConfigs,
      outputDir: join(rootDir, 'reviewed'),
      clock: () => now,
      gzipSnapshots: false,
      writeManifest: true,
    });

    await refresh.refreshConfiguredExports();
    now = new Date('2026-03-29T12:00:00.000Z');
    await refresh.refreshConfiguredExports();

    const snapshotDir = join(rootDir, 'reviewed', 'snapshots', tenantPackFixture.tenantId, tenantPackFixture.useCase);
    const snapshots = (await readdir(snapshotDir)).filter((name) => name.endsWith('.jsonl'));
    expect(snapshots).toHaveLength(1);

    const manifest = reviewedRunExportManifestSchema.parse(JSON.parse(
      await readFile(join(rootDir, 'reviewed', tenantPackFixture.tenantId, `${tenantPackFixture.useCase}.manifest.json`), 'utf8'),
    ));
    expect(manifest.includeTranscript).toBe(false);
    expect(manifest.classification).toBe('INTERNAL');
    expect(manifest.maximumSnapshots).toBe(1);
    expect(manifest.coverageFailures).toEqual(expect.arrayContaining([
      'Reviewed record count 1 is below minimum 2.',
      'Analyst sentiment count 1 is below minimum 2.',
    ]));
  });
});
