import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConversationIntelligenceService,
  FileModelValidationReportStore,
  FileTenantAdminConfigRegistry,
  FileTenantPackRegistry,
  InMemoryRuntimeObservability,
  ModelValidationService,
  ReviewedRunExportRefreshService,
  SqliteJobStore,
  TenantPackDraft,
  analysisJobRecordSchema,
  canonicalExtractionSchema,
  conversationAnalysisSchema,
  reviewedRunExportRecordSchema,
} from '../src';
import { StubCanonicalAnalysisEngine } from '../src/rlm/engine';
import tenantPackFixture from '../fixtures/tenant-pack.support.acme.json';
import transcriptFixture from '../fixtures/transcript.support.basic.json';

function buildCompletedAnalysis(input: {
  jobId: string;
  packVersion: string;
  reviewState: 'VERIFIED' | 'NEEDS_REVIEW' | 'UNCERTAIN';
  score100: number;
  analystScore100?: number;
}) {
  const score5 = Math.min(5, Math.floor(Math.max(input.score100 - 1, 0) / 20) + 1);
  const analystScore5 = typeof input.analystScore100 === 'number'
    ? Math.min(5, Math.floor(Math.max(input.analystScore100 - 1, 0) / 20) + 1)
    : undefined;

  return conversationAnalysisSchema.parse({
    jobId: input.jobId,
    tenantId: tenantPackFixture.tenantId,
    conversationId: `${input.jobId}_conversation`,
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
      polarity: input.score100 < 50 ? 'NEGATIVE' : input.score100 > 50 ? 'POSITIVE' : 'NEUTRAL',
      intensity: Math.abs(input.score100 - 50) / 50,
      confidence: 0.92,
      rationale: 'Synthetic model validation sentiment.',
      score: {
        method: 'derived_v1',
        score100: input.score100,
        score5,
      },
    },
    aspectSentiments: [],
    canonicalEvents: [],
    canonicalKeyMoments: [],
    tenantMappedEvents: [],
    speakerAssignments: [],
    review: {
      state: input.reviewState,
      reasons: input.reviewState === 'VERIFIED' ? [] : ['Synthetic review state for model validation.'],
      comments: [],
      history: [],
      resolution: {
        decision: input.reviewState === 'VERIFIED'
          ? 'VERIFY'
          : input.reviewState === 'UNCERTAIN'
            ? 'MARK_UNCERTAIN'
            : 'KEEP_NEEDS_REVIEW',
        resultingState: input.reviewState,
        decidedAt: '2026-03-28T11:35:00.000Z',
        actorId: 'analyst_1',
        actorType: 'USER',
      },
      analystSentiment: typeof input.analystScore100 === 'number'
        ? {
          score100: input.analystScore100,
          score5: analystScore5,
          correctionApplied: true,
          reviewedAt: '2026-03-28T11:35:00.000Z',
          reviewedById: 'analyst_1',
          reviewedByType: 'USER',
        }
        : undefined,
    },
    summary: 'Synthetic model validation run.',
    trace: {
      engine: 'rules',
      model: 'test-model',
      packVersion: input.packVersion,
      promptVersion: 'test-prompt',
      generatedAt: '2026-03-28T11:30:00.000Z',
    },
  });
}

describe('ModelValidationService', () => {
  const tempDirs: string[] = [];
  const closables: Array<{ close(): void }> = [];

  afterEach(async () => {
    await Promise.allSettled(closables.map(async (closable) => closable.close()));
    closables.length = 0;
    await Promise.allSettled(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('exports reviewed runs and produces validation reports with alerts', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-model-validation-'));
    tempDirs.push(rootDir);

    const store = new SqliteJobStore(join(rootDir, 'jobs.sqlite'));
    closables.push(store);
    await store.initialize();

    const tenantPacks = new FileTenantPackRegistry(join(rootDir, 'tenant-packs'), () => new Date('2026-03-28T12:00:00.000Z'));
    await tenantPacks.initialize();
    const tenantAdminConfigs = new FileTenantAdminConfigRegistry(join(rootDir, 'tenant-admin'), () => new Date('2026-03-28T12:00:00.000Z'));
    await tenantAdminConfigs.initialize();
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
      clock: () => new Date('2026-03-28T12:00:00.000Z'),
    });

    const notifiedReports: string[] = [];
    const observability = new InMemoryRuntimeObservability();
    const validation = new ModelValidationService({
      service,
      tenantPacks,
      tenantAdminConfigs,
      reportStore: reports,
      reviewedDataDir: join(rootDir, 'reviewed'),
      clock: () => new Date('2026-03-28T12:00:00.000Z'),
      observability,
      notifier: {
        notify: async (report) => {
          notifiedReports.push(report.reportId);
        },
      },
    });
    const reviewedExports = new ReviewedRunExportRefreshService({
      validation,
      tenantAdminConfigs,
      outputDir: join(rootDir, 'reviewed'),
      clock: () => new Date('2026-03-28T12:00:00.000Z'),
      gzipSnapshots: true,
      writeManifest: true,
      observability,
    });

    const v1 = tenantPackFixture as TenantPackDraft;
    const v2 = {
      ...tenantPackFixture,
      packVersion: 'support-v2',
      policyDigest: [...tenantPackFixture.policyDigest, 'Synthetic validation release.'],
    } as TenantPackDraft;

    await tenantPacks.publish({ tenantPack: v1 });
    await tenantPacks.publish({
      tenantPack: v2,
      release: {
        mode: 'CANARY',
        canaryPercentage: 10,
      },
    });
    await tenantPacks.evaluateCanary({
      tenantId: tenantPackFixture.tenantId,
      useCase: tenantPackFixture.useCase,
      targetPackVersion: 'support-v2',
      metrics: {
        sampleSize: 10,
        failureRate: 0.4,
        reviewRate: 0.5,
        uncertainRate: 0.2,
        averageScore100: 40,
      },
      applyResult: false,
      note: 'Synthetic canary failure for validation alert coverage.',
    }, {
      actorId: 'svc_validation',
      actorType: 'SYSTEM',
    });

    await tenantAdminConfigs.set({
      tenantId: tenantPackFixture.tenantId,
      useCase: tenantPackFixture.useCase,
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
      validationMonitoring: {
        enabled: true,
        minimumIntervalMinutes: 60,
        evaluationWindowHours: 24,
        thresholds: {
          minimumReviewedSampleSize: 1,
          maximumFailureRate: 0.1,
          maximumReviewRate: 0.2,
          maximumUncertainRate: 0.2,
          minimumSchemaValidRate: 0.9,
          maximumAverageDeltaScore100: 5,
          maximumAverageDeltaScore5: 0.5,
          minimumExactScore5MatchRate: 0.8,
          minimumWithinFivePointsRate: 0.95,
          maximumAverageProcessingDurationMs: 5000,
          maximumP95ProcessingDurationMs: 9000,
          byEngagementType: {
            TICKET: {
              maximumUncertainRate: 0.05,
              maximumAverageProcessingDurationMs: 7000,
            },
          },
          byQueue: {
            support_async: {
              maximumUncertainRate: 0.05,
            },
          },
          byTranscriptLengthBucket: {
            VERY_LONG: {
              maximumP95ProcessingDurationMs: 8000,
            },
          },
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
      },
    });

    const jobs = [
      {
        jobId: 'validated_verified',
        status: 'COMPLETED' as const,
        result: buildCompletedAnalysis({
          jobId: 'validated_verified',
          packVersion: 'support-v2',
          reviewState: 'VERIFIED',
          score100: 70,
          analystScore100: 30,
        }),
      },
      {
        jobId: 'validated_needs_review',
        status: 'COMPLETED' as const,
        result: buildCompletedAnalysis({
          jobId: 'validated_needs_review',
          packVersion: 'support-v2',
          reviewState: 'NEEDS_REVIEW',
          score100: 45,
        }),
      },
      {
        jobId: 'validated_uncertain',
        status: 'COMPLETED' as const,
        result: buildCompletedAnalysis({
          jobId: 'validated_uncertain',
          packVersion: 'support-v2',
          reviewState: 'UNCERTAIN',
          score100: 35,
        }),
      },
      {
        jobId: 'validated_failed',
        status: 'FAILED' as const,
        result: undefined,
      },
    ];

    for (const job of jobs) {
      const transcript = structuredClone(transcriptFixture);
      transcript.turns[0].text = job.jobId === 'validated_verified'
        ? 'Reach me at sam@example.com about order ORD-1234.'
        : job.jobId === 'validated_needs_review'
          ? `Reach me at sam@example.com about order ORD-1234. ${'medium '.repeat(80)}`
          : job.jobId === 'validated_uncertain'
            ? `Reach me at sam@example.com about order ORD-1234. ${'long '.repeat(350)}`
            : `Reach me at sam@example.com about order ORD-1234. ${'verylong '.repeat(700)}`;
      transcript.metadata = {
        ...transcript.metadata,
        engagementType: job.jobId === 'validated_uncertain' ? 'TICKET' : 'CALL',
        queue: job.jobId === 'validated_uncertain' ? 'support_async' : 'support_voice',
      };
      await store.createJob(analysisJobRecordSchema.parse({
        jobId: job.jobId,
        status: job.status,
        tenantId: tenantPackFixture.tenantId,
        conversationId: `${job.jobId}_conversation`,
        useCase: tenantPackFixture.useCase,
        createdAt: '2026-03-28T11:30:00.000Z',
        updatedAt: '2026-03-28T11:40:00.000Z',
        request: {
          transcript,
          tenantPack: v2,
          piiConfig: {
            enabled: true,
            maskDisplayNames: false,
            customRegexRules: [],
          },
        },
        piiRedactionSummary: {
          applied: true,
          redactionCount: 2,
          ruleHits: {
            EMAIL: 1,
            ACCOUNT_TOKEN: 1,
          },
        },
        result: job.result,
        error: job.status === 'FAILED'
          ? { message: 'Synthetic failure for model validation.' }
          : undefined,
      }));

      await store.appendRunEvent({
        eventId: `${job.jobId}_terminal`,
        runId: job.jobId,
        tenantId: tenantPackFixture.tenantId,
        type: job.status === 'COMPLETED' ? 'RUN_COMPLETED' : 'RUN_FAILED',
        createdAt: '2026-03-28T11:40:00.000Z',
        summary: job.status === 'COMPLETED' ? 'Synthetic completed run.' : 'Synthetic failed run.',
        metadata: job.status === 'COMPLETED'
          ? {
            durationMs: job.jobId === 'validated_verified' ? 4000 : job.jobId === 'validated_needs_review' ? 6000 : 8000,
            schemaValidationPassed: true,
          }
          : {
            durationMs: 12000,
            failureKind: 'SCHEMA_INVALID',
            schemaValidationPassed: false,
          },
      });
    }

    const exportResult = await validation.exportReviewedRuns({
      tenantId: tenantPackFixture.tenantId,
      useCase: tenantPackFixture.useCase,
      packVersion: 'support-v2',
      includeTranscript: true,
      requireAnalystSentiment: true,
    });

    expect(exportResult.response.exportedCount).toBe(1);
    expect(exportResult.ndjson).toContain('[PII:EMAIL]');
    expect(exportResult.ndjson).toContain('validated_verified');
    expect(exportResult.records[0].review.analystSentiment?.score5).toBe(2);
    expect(exportResult.records[0].engagementType).toBe('CALL');
    expect(exportResult.records[0].queue).toBe('support_voice');
    expect(exportResult.records[0].transcriptLengthBucket).toBe('SHORT');

    const refreshed = await reviewedExports.refreshConfiguredExports({
      tenantId: tenantPackFixture.tenantId,
      useCase: tenantPackFixture.useCase,
      force: true,
      requireAnalystSentiment: true,
    });
    expect(refreshed.results).toHaveLength(1);

    const datasetInventory = await validation.listReviewedDatasets({
      tenantId: tenantPackFixture.tenantId,
      useCase: tenantPackFixture.useCase,
    });
    expect(datasetInventory.scopes).toHaveLength(1);
    expect(datasetInventory.scopes[0].recordCount).toBe(1);
    expect(datasetInventory.scopes[0].analystSentimentCount).toBe(1);
    expect(datasetInventory.scopes[0].files.some((file) => file.snapshot)).toBe(true);
    expect(datasetInventory.scopes[0].files.some((file) => file.compression === 'GZIP')).toBe(true);
    expect(datasetInventory.scopes[0].byQueue.support_voice).toBe(1);
    expect(datasetInventory.scopes[0].byTranscriptLengthBucket.SHORT).toBe(1);
    expect(refreshed.results[0]?.manifestPath).toContain('.manifest.json');
    expect(refreshed.results[0]?.analystSentimentCount).toBe(1);

    const scopeReports = await validation.runScope({
      tenantId: tenantPackFixture.tenantId,
      useCase: tenantPackFixture.useCase,
      packVersion: 'support-v2',
    });

    expect(scopeReports).toHaveLength(1);
    expect(scopeReports[0].liveMetrics.runCount).toBe(4);
    expect(scopeReports[0].liveMetrics.failedRuns).toBe(1);
    expect(scopeReports[0].liveMetrics.reviewCount).toBe(1);
    expect(scopeReports[0].liveMetrics.uncertainCount).toBe(1);
    expect(scopeReports[0].liveMetrics.schemaValidRate).toBe(0.75);
    expect(scopeReports[0].liveMetrics.averageProcessingDurationMs).toBe(7500);
    expect(scopeReports[0].liveMetrics.p95ProcessingDurationMs).toBe(12000);
    expect(scopeReports[0].liveMetrics.byEngagementType.CALL.runCount).toBe(3);
    expect(scopeReports[0].liveMetrics.byEngagementType.TICKET.runCount).toBe(1);
    expect(scopeReports[0].liveMetrics.byQueue.support_voice.runCount).toBe(3);
    expect(scopeReports[0].liveMetrics.byQueue.support_async.runCount).toBe(1);
    expect(scopeReports[0].liveMetrics.byTranscriptLengthBucket.SHORT.runCount).toBe(1);
    expect(scopeReports[0].liveMetrics.byTranscriptLengthBucket.MEDIUM.runCount).toBe(1);
    expect(scopeReports[0].liveMetrics.byTranscriptLengthBucket.LONG.runCount).toBe(1);
    expect(scopeReports[0].liveMetrics.byTranscriptLengthBucket.VERY_LONG.runCount).toBe(1);
    expect(scopeReports[0].reviewedMetrics?.total).toBe(1);
    expect(scopeReports[0].reviewedMetrics?.averageDeltaScore100).toBe(40);
    expect(scopeReports[0].reviewedMetrics?.byEngagementType.CALL.total).toBe(1);
    expect(scopeReports[0].reviewedMetrics?.byQueue.support_voice.total).toBe(1);
    expect(scopeReports[0].reviewedMetrics?.byTranscriptLengthBucket.SHORT.total).toBe(1);
    expect(scopeReports[0].alerts.map((alert) => alert.kind)).toEqual(expect.arrayContaining([
      'CANARY_REJECTED',
      'FAILURE_RATE_HIGH',
      'REVIEW_RATE_HIGH',
      'SCHEMA_VALID_RATE_LOW',
      'LATENCY_HIGH',
      'SCORE_DRIFT_HIGH',
      'SCORE_BUCKET_MATCH_LOW',
    ]));
    expect(scopeReports[0].alerts.some((alert) => alert.metadata.engagementType === 'TICKET' && alert.kind === 'UNCERTAIN_RATE_HIGH')).toBe(true);
    expect(scopeReports[0].alerts.some((alert) => alert.metadata.queue === 'support_async' && alert.kind === 'UNCERTAIN_RATE_HIGH')).toBe(true);
    expect(scopeReports[0].alerts.some((alert) => alert.metadata.queue === 'support_async' && alert.kind === 'REVIEWED_SAMPLE_SIZE_LOW')).toBe(true);
    expect(scopeReports[0].alerts.some((alert) => alert.metadata.transcriptLengthBucket === 'VERY_LONG' && alert.kind === 'LATENCY_HIGH')).toBe(true);
    expect(notifiedReports).toHaveLength(1);
    expect(observability.metrics.some((metric) => metric.kind === 'gauge'
      && metric.name === 'conversation_intelligence.reviewed_exports.records'
      && metric.value === 1)).toBe(true);
    expect(observability.metrics.some((metric) => metric.kind === 'gauge'
      && metric.name === 'conversation_intelligence.model_validation.failure_rate'
      && metric.value === scopeReports[0].liveMetrics.failureRate)).toBe(true);
    expect(observability.metrics.some((metric) => metric.kind === 'gauge'
      && metric.name === 'conversation_intelligence.model_validation.scope_live_runs'
      && metric.attributes.scope_type === 'QUEUE'
      && metric.attributes.scope_value === 'support_voice')).toBe(true);

    const recommendation = await validation.recommendThresholds({
      tenantId: tenantPackFixture.tenantId,
      useCase: tenantPackFixture.useCase,
      packVersion: 'support-v2',
    });
    expect(recommendation.recommendedThresholds.minimumSchemaValidRate).toBeGreaterThanOrEqual(0.9);
    expect(recommendation.recommendedThresholds.maximumAverageProcessingDurationMs).toBeGreaterThanOrEqual(8625);
    expect(recommendation.observedLiveMetrics.byQueue.support_voice.runCount).toBe(3);
    expect(recommendation.observedLiveMetrics.byTranscriptLengthBucket.VERY_LONG.runCount).toBe(1);
    expect(recommendation.recommendedThresholds.byEngagementType.CALL).toBeDefined();
    expect(recommendation.recommendedThresholds.byQueue.support_voice).toBeDefined();
    expect(recommendation.recommendedThresholds.byTranscriptLengthBucket.SHORT).toBeDefined();
    expect(recommendation.notes.length).toBeGreaterThan(0);

    const applied = await validation.applyRecommendedThresholds({
      tenantId: tenantPackFixture.tenantId,
      useCase: tenantPackFixture.useCase,
      packVersion: 'support-v2',
      nightlyIntervalMinutes: 1440,
      minimumRunCount: 1,
      minimumReviewedSampleSize: 1,
      autoApply: true,
    });
    expect(applied.applied).toBe(true);
    expect(applied.appliedThresholds).toEqual(recommendation.recommendedThresholds);
    expect(applied.validationMonitoring.enabled).toBe(true);
    expect(applied.validationMonitoring.minimumIntervalMinutes).toBe(1440);
    expect(applied.validationMonitoring.recommendations.autoApply).toBe(true);
    expect(applied.validationMonitoring.recommendations.lastAppliedAt).toBe('2026-03-28T12:00:00.000Z');
    expect(applied.validationMonitoring.recommendations.lastAppliedPackVersion).toBe('support-v2');

    const storedAlerts = await reports.listAlerts({
      tenantId: tenantPackFixture.tenantId,
      useCase: tenantPackFixture.useCase,
      packVersion: 'support-v2',
    });
    expect(storedAlerts.map((alert) => alert.kind)).toEqual(expect.arrayContaining([
      'CANARY_REJECTED',
      'FAILURE_RATE_HIGH',
      'REVIEW_RATE_HIGH',
      'SCHEMA_VALID_RATE_LOW',
      'LATENCY_HIGH',
      'SCORE_DRIFT_HIGH',
      'SCORE_BUCKET_MATCH_LOW',
    ]));
  });

  it('auto-applies configured threshold recommendations only on the configured interval', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-model-validation-auto-apply-'));
    tempDirs.push(rootDir);

    const store = new SqliteJobStore(join(rootDir, 'jobs.sqlite'));
    closables.push(store);
    await store.initialize();

    const tenantPacks = new FileTenantPackRegistry(join(rootDir, 'tenant-packs'), () => new Date('2026-03-28T12:00:00.000Z'));
    await tenantPacks.initialize();
    const tenantAdminConfigs = new FileTenantAdminConfigRegistry(join(rootDir, 'tenant-admin'), () => new Date('2026-03-28T12:00:00.000Z'));
    await tenantAdminConfigs.initialize();
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
      clock: () => new Date('2026-03-28T12:00:00.000Z'),
    });

    const validation = new ModelValidationService({
      service,
      tenantPacks,
      tenantAdminConfigs,
      reportStore: reports,
      reviewedDataDir: join(rootDir, 'reviewed'),
      clock: () => new Date('2026-03-28T12:00:00.000Z'),
    });
    const reviewedExports = new ReviewedRunExportRefreshService({
      validation,
      tenantAdminConfigs,
      outputDir: join(rootDir, 'reviewed'),
      clock: () => new Date('2026-03-28T12:00:00.000Z'),
    });

    const pack = tenantPackFixture as TenantPackDraft;
    const packUseCase = pack.useCase ?? 'support';
    const packVersion = pack.packVersion ?? tenantPackFixture.packVersion;
    await tenantPacks.publish({ tenantPack: pack });
    await tenantAdminConfigs.set({
      tenantId: pack.tenantId,
      useCase: packUseCase,
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
      validationMonitoring: {
        enabled: true,
        minimumIntervalMinutes: 1440,
        evaluationWindowHours: 24,
        thresholds: {
          minimumReviewedSampleSize: 1,
          maximumFailureRate: 0.1,
          maximumReviewRate: 0.5,
          maximumUncertainRate: 0.5,
          minimumSchemaValidRate: 0.9,
          maximumAverageDeltaScore100: 5,
          maximumAverageDeltaScore5: 0.5,
          minimumExactScore5MatchRate: 0.75,
          minimumWithinFivePointsRate: 0.95,
          maximumAverageProcessingDurationMs: 5000,
          maximumP95ProcessingDurationMs: 9000,
        },
        recommendations: {
          autoApply: true,
          minimumIntervalMinutes: 1440,
          minimumRunCount: 1,
          minimumReviewedSampleSize: 1,
          minimumRunCountPerEngagementType: 1,
          minimumReviewedSampleSizePerEngagementType: 1,
        },
      },
    });

    await store.createJob(analysisJobRecordSchema.parse({
      jobId: 'auto_apply_run',
      status: 'COMPLETED',
      tenantId: pack.tenantId,
      conversationId: 'auto_apply_conversation',
      useCase: pack.useCase,
      createdAt: '2026-03-28T11:30:00.000Z',
      updatedAt: '2026-03-28T11:40:00.000Z',
      request: {
        transcript: structuredClone(transcriptFixture),
        tenantPack: pack,
        piiConfig: {
          enabled: true,
          maskDisplayNames: false,
          customRegexRules: [],
        },
      },
      result: buildCompletedAnalysis({
        jobId: 'auto_apply_run',
        packVersion: pack.packVersion,
        reviewState: 'VERIFIED',
        score100: 62,
        analystScore100: 58,
      }),
    }));
    await store.appendRunEvent({
      eventId: 'auto_apply_run_terminal',
      runId: 'auto_apply_run',
      tenantId: pack.tenantId,
      type: 'RUN_COMPLETED',
      createdAt: '2026-03-28T11:40:00.000Z',
      summary: 'Synthetic completed run.',
      metadata: {
        durationMs: 3000,
        schemaValidationPassed: true,
      },
    });

    await reviewedExports.refreshConfiguredExports({
      tenantId: pack.tenantId,
      useCase: pack.useCase,
      force: true,
      requireAnalystSentiment: true,
    });
    await reviewedExports.refreshConfiguredExports({
      tenantId: pack.tenantId,
      useCase: pack.useCase,
      force: true,
      requireAnalystSentiment: true,
    });

    const recommendation = await validation.recommendThresholds({
      tenantId: pack.tenantId,
      useCase: pack.useCase,
      packVersion: pack.packVersion,
    });
    expect(recommendation.observedReviewedMetrics?.total).toBe(1);

    const first = await validation.applyConfiguredThresholdRecommendations();
    expect(first.results).toHaveLength(1);
    expect(first.results[0].applied).toBe(true);

    const second = await validation.applyConfiguredThresholdRecommendations();
    expect(second.results).toHaveLength(0);
    expect(second.skipped).toEqual([
      {
        tenantId: pack.tenantId,
        useCase: pack.useCase,
        reason: 'Threshold recommendations were applied too recently; wait at least 1440 minutes between auto-apply runs.',
      },
    ]);
  });

  it('loads reviewed snapshot directories and prefers the latest reviewed rows for nightly validation', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-model-validation-snapshots-'));
    tempDirs.push(rootDir);

    const store = new SqliteJobStore(join(rootDir, 'jobs.sqlite'));
    closables.push(store);
    await store.initialize();

    const tenantPacks = new FileTenantPackRegistry(join(rootDir, 'tenant-packs'), () => new Date('2026-03-28T12:00:00.000Z'));
    await tenantPacks.initialize();
    const tenantAdminConfigs = new FileTenantAdminConfigRegistry(join(rootDir, 'tenant-admin'), () => new Date('2026-03-28T12:00:00.000Z'));
    await tenantAdminConfigs.initialize();
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
      clock: () => new Date('2026-03-28T12:00:00.000Z'),
    });

    const validation = new ModelValidationService({
      service,
      tenantPacks,
      tenantAdminConfigs,
      reportStore: reports,
      reviewedDataDir: join(rootDir, 'reviewed'),
      clock: () => new Date('2026-03-28T12:00:00.000Z'),
    });

    const pack = tenantPackFixture as TenantPackDraft;
    const packUseCase = pack.useCase ?? 'support';
    const packVersion = pack.packVersion ?? tenantPackFixture.packVersion;
    await tenantPacks.publish({ tenantPack: pack });
    await tenantAdminConfigs.set({
      tenantId: pack.tenantId,
      useCase: packUseCase,
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
        enabled: true,
        minimumIntervalMinutes: 60,
        evaluationWindowHours: 48,
        thresholds: {
          minimumReviewedSampleSize: 1,
          maximumFailureRate: 0.5,
          maximumReviewRate: 0.5,
          maximumUncertainRate: 0.5,
          minimumSchemaValidRate: 0.9,
          maximumAverageDeltaScore100: 20,
          maximumAverageDeltaScore5: 1,
          minimumExactScore5MatchRate: 0.5,
          minimumWithinFivePointsRate: 0.5,
          maximumAverageProcessingDurationMs: 10000,
          maximumP95ProcessingDurationMs: 15000,
          byEngagementType: {},
        },
        recommendations: {
          autoApply: false,
          minimumIntervalMinutes: 1440,
          minimumRunCount: 1,
          minimumReviewedSampleSize: 1,
          minimumRunCountPerEngagementType: 1,
          minimumReviewedSampleSizePerEngagementType: 1,
        },
      },
    });

    const snapshotDir = join(rootDir, 'reviewed', pack.tenantId, packUseCase);
    await mkdir(snapshotDir, { recursive: true });

    const olderSnapshot = [
      reviewedRunExportRecordSchema.parse({
        runId: 'snapshot-run-001',
        tenantId: pack.tenantId,
        useCase: packUseCase,
        engagementType: 'EMAIL',
        queue: 'support_email',
        transcriptTurnCount: 2,
        transcriptCharacterCount: 220,
        transcriptLengthBucket: 'SHORT',
        createdAt: '2026-03-27T10:00:00.000Z',
        updatedAt: '2026-03-27T10:05:00.000Z',
        packVersion,
        model: {
          polarity: 'NEGATIVE',
          intensity: 0.6,
          confidence: 0.9,
          rationale: 'Snapshot sample one.',
        },
        review: {
          state: 'VERIFIED',
          decision: 'VERIFY',
          reviewedAt: '2026-03-27T10:05:00.000Z',
          reviewedById: 'analyst_1',
          reviewedByType: 'USER',
          analystSentiment: {
            score100: 20,
            score5: 1,
            correctionApplied: false,
            reviewedAt: '2026-03-27T10:05:00.000Z',
            reviewedById: 'analyst_1',
            reviewedByType: 'USER',
          },
          reasons: [],
        },
      }),
      reviewedRunExportRecordSchema.parse({
        runId: 'snapshot-run-002',
        tenantId: pack.tenantId,
        useCase: packUseCase,
        engagementType: 'TICKET',
        queue: 'support_async',
        transcriptTurnCount: 4,
        transcriptCharacterCount: 1400,
        transcriptLengthBucket: 'LONG',
        createdAt: '2026-03-27T11:00:00.000Z',
        updatedAt: '2026-03-27T11:05:00.000Z',
        packVersion,
        model: {
          polarity: 'POSITIVE',
          intensity: 0.4,
          confidence: 0.92,
          rationale: 'Snapshot sample two.',
        },
        review: {
          state: 'VERIFIED',
          decision: 'VERIFY',
          reviewedAt: '2026-03-27T11:05:00.000Z',
          reviewedById: 'analyst_2',
          reviewedByType: 'USER',
          analystSentiment: {
            score100: 72,
            score5: 4,
            correctionApplied: false,
            reviewedAt: '2026-03-27T11:05:00.000Z',
            reviewedById: 'analyst_2',
            reviewedByType: 'USER',
          },
          reasons: [],
        },
      }),
    ];

    const newerSnapshot = [
      reviewedRunExportRecordSchema.parse({
        runId: 'snapshot-run-001',
        tenantId: pack.tenantId,
        useCase: packUseCase,
        engagementType: 'EMAIL',
        queue: 'support_email',
        transcriptTurnCount: 2,
        transcriptCharacterCount: 220,
        transcriptLengthBucket: 'SHORT',
        createdAt: '2026-03-27T10:00:00.000Z',
        updatedAt: '2026-03-28T09:05:00.000Z',
        packVersion,
        model: {
          polarity: 'NEGATIVE',
          intensity: 0.6,
          confidence: 0.9,
          rationale: 'Snapshot sample one updated.',
        },
        review: {
          state: 'VERIFIED',
          decision: 'VERIFY',
          reviewedAt: '2026-03-28T09:05:00.000Z',
          reviewedById: 'analyst_3',
          reviewedByType: 'USER',
          analystSentiment: {
            score100: 40,
            score5: 2,
            correctionApplied: true,
            reviewedAt: '2026-03-28T09:05:00.000Z',
            reviewedById: 'analyst_3',
            reviewedByType: 'USER',
          },
          reasons: [],
        },
      }),
    ];

    await writeFile(
      join(snapshotDir, '2026-03-27T120000Z.jsonl'),
      `${olderSnapshot.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );
    await writeFile(
      join(snapshotDir, '2026-03-28T120000Z.jsonl'),
      `${newerSnapshot.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );

    const reportsForScope = await validation.runScope({
      tenantId: pack.tenantId,
      useCase: packUseCase,
      packVersion,
    });

    expect(reportsForScope).toHaveLength(1);
    expect(reportsForScope[0].reviewedMetrics?.total).toBe(2);
    expect(reportsForScope[0].reviewedMetrics?.averageDeltaScore100).toBe(11);
    expect(reportsForScope[0].reviewedMetrics?.byQueue.support_email.total).toBe(1);
    expect(reportsForScope[0].reviewedMetrics?.byQueue.support_async.total).toBe(1);
    expect(reportsForScope[0].reviewedMetrics?.byTranscriptLengthBucket.SHORT.total).toBe(1);
    expect(reportsForScope[0].reviewedMetrics?.byTranscriptLengthBucket.LONG.total).toBe(1);
  });

  it('skips nightly validation when reviewed dataset readiness thresholds are not met', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-model-validation-readiness-'));
    tempDirs.push(rootDir);

    const store = new SqliteJobStore(join(rootDir, 'jobs.sqlite'));
    closables.push(store);
    await store.initialize();

    const tenantPacks = new FileTenantPackRegistry(join(rootDir, 'tenant-packs'), () => new Date('2026-03-29T12:00:00.000Z'));
    await tenantPacks.initialize();
    const tenantAdminConfigs = new FileTenantAdminConfigRegistry(join(rootDir, 'tenant-admin'), () => new Date('2026-03-29T12:00:00.000Z'));
    await tenantAdminConfigs.initialize();
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
      clock: () => new Date('2026-03-29T12:00:00.000Z'),
    });

    const validation = new ModelValidationService({
      service,
      tenantPacks,
      tenantAdminConfigs,
      reportStore: reports,
      reviewedDataDir: join(rootDir, 'reviewed'),
      clock: () => new Date('2026-03-29T12:00:00.000Z'),
    });

    const pack = tenantPackFixture as TenantPackDraft;
    await tenantPacks.publish({ tenantPack: pack });
    await tenantAdminConfigs.set({
      tenantId: pack.tenantId,
      useCase: pack.useCase,
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
        enabled: true,
        minimumIntervalMinutes: 60,
        evaluationWindowHours: 48,
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
          includeTranscript: true,
          requireAnalystSentiment: false,
          classification: 'RESTRICTED',
          retentionDays: 30,
          maximumSnapshots: 30,
        },
        reviewedDatasetReadiness: {
          minimumRecordCount: 2,
          minimumAnalystSentimentCount: 2,
          byEngagementType: {
            CALL: 1,
          },
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
      updatedAt: '2026-03-29T12:00:00.000Z',
    });

    const reviewedDir = join(rootDir, 'reviewed', pack.tenantId);
    await mkdir(reviewedDir, { recursive: true });
    await writeFile(
      join(reviewedDir, `${pack.useCase}.jsonl`),
      `${JSON.stringify(reviewedRunExportRecordSchema.parse({
        runId: 'readiness-run-001',
        tenantId: pack.tenantId,
        useCase: pack.useCase,
        engagementType: 'EMAIL',
        queue: 'support_email',
        transcriptTurnCount: 2,
        transcriptCharacterCount: 120,
        transcriptLengthBucket: 'SHORT',
        createdAt: '2026-03-29T10:00:00.000Z',
        updatedAt: '2026-03-29T10:05:00.000Z',
        packVersion: pack.packVersion,
        model: {
          polarity: 'NEGATIVE',
          intensity: 0.5,
          confidence: 0.9,
          rationale: 'Readiness sample.',
        },
        review: {
          state: 'VERIFIED',
          decision: 'VERIFY',
          reviewedAt: '2026-03-29T10:05:00.000Z',
          reviewedById: 'analyst_1',
          reviewedByType: 'USER',
          analystSentiment: {
            score100: 24,
            score5: 2,
            correctionApplied: false,
            reviewedAt: '2026-03-29T10:05:00.000Z',
            reviewedById: 'analyst_1',
            reviewedByType: 'USER',
          },
          reasons: [],
        },
      }))}\n`,
      'utf8',
    );

    const result = await validation.runConfiguredValidations();

    expect(result.reports).toHaveLength(0);
    expect(result.skipped).toEqual([
      {
        tenantId: pack.tenantId,
        useCase: pack.useCase,
        reason: expect.stringContaining('Reviewed dataset readiness failed:'),
      },
    ]);
  });
});
