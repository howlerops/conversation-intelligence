import { mkdtemp, rm } from 'fs/promises';
import { Server } from 'http';
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
  startConversationIntelligenceServer,
} from '../src';
import { StubCanonicalAnalysisEngine } from '../src/rlm/engine';
import tenantPackFixture from '../fixtures/tenant-pack.support.acme.json';
import transcriptFixture from '../fixtures/transcript.support.basic.json';

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

function buildCompletedAnalysis(jobId: string, packVersion: string) {
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
      polarity: 'NEGATIVE',
      intensity: 0.8,
      confidence: 0.9,
      rationale: 'Synthetic HTTP validation sentiment.',
      score: {
        method: 'derived_v1',
        score100: 10,
        score5: 1,
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
        decidedAt: '2026-03-28T11:35:00.000Z',
        actorId: 'analyst_1',
        actorType: 'USER',
      },
      analystSentiment: {
        score100: 40,
        score5: 2,
        correctionApplied: true,
        reviewedAt: '2026-03-28T11:35:00.000Z',
        reviewedById: 'analyst_1',
        reviewedByType: 'USER',
      },
    },
    summary: 'Synthetic HTTP validation run.',
    trace: {
      engine: 'rules',
      model: 'test-model',
      packVersion,
      promptVersion: 'test-prompt',
      generatedAt: '2026-03-28T11:30:00.000Z',
    },
  });
}

describe('model validation HTTP routes', () => {
  const tempDirs: string[] = [];
  const closables: Array<{ close(): void }> = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.allSettled(servers.map(async (server) => stopServer(server)));
    servers.length = 0;
    await Promise.allSettled(closables.map(async (closable) => closable.close()));
    closables.length = 0;
    await Promise.allSettled(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('exports reviewed runs and serves reports and alerts over HTTP', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-model-validation-http-'));
    tempDirs.push(rootDir);

    const store = new SqliteJobStore(join(rootDir, 'jobs.sqlite'));
    closables.push(store);
    await store.initialize();

    const tenantPacks = new FileTenantPackRegistry(join(rootDir, 'tenant-packs'), () => new Date('2026-03-28T12:00:00.000Z'));
    await tenantPacks.initialize();
    const tenantAdminConfigs = new FileTenantAdminConfigRegistry(join(rootDir, 'tenant-admin'), () => new Date('2026-03-28T12:00:00.000Z'));
    await tenantAdminConfigs.initialize();
    const reportStore = new FileModelValidationReportStore(join(rootDir, 'reports'));
    await reportStore.initialize();

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
      reportStore,
      reviewedDataDir: join(rootDir, 'reviewed'),
      clock: () => new Date('2026-03-28T12:00:00.000Z'),
    });
    const reviewedExports = new ReviewedRunExportRefreshService({
      validation,
      tenantAdminConfigs,
      outputDir: join(rootDir, 'reviewed'),
      clock: () => new Date('2026-03-28T12:00:00.000Z'),
    });

    const v1 = tenantPackFixture as TenantPackDraft;
    const v2 = {
      ...tenantPackFixture,
      packVersion: 'support-v2',
      policyDigest: [...tenantPackFixture.policyDigest, 'HTTP validation release.'],
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
        sampleSize: 5,
        failureRate: 0.3,
        reviewRate: 0.1,
        uncertainRate: 0,
      },
      applyResult: false,
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
        minimumIntervalMinutes: 1,
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
          byQueue: {
            support_voice: {
              maximumAverageDeltaScore100: 25,
            },
          },
          byTranscriptLengthBucket: {
            SHORT: {
              maximumAverageDeltaScore100: 25,
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

    const transcript = structuredClone(transcriptFixture);
    transcript.turns[0].text = 'Email sam@example.com for refund follow-up.';
    transcript.metadata = {
      ...transcript.metadata,
      engagementType: 'CALL',
      queue: 'support_voice',
    };

    await store.createJob(analysisJobRecordSchema.parse({
      jobId: 'validated_http_completed',
      status: 'COMPLETED',
      tenantId: tenantPackFixture.tenantId,
      conversationId: 'validated_http_completed_conversation',
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
      result: buildCompletedAnalysis('validated_http_completed', 'support-v2'),
    }));
    await store.appendRunEvent({
      eventId: 'validated_http_completed_terminal',
      runId: 'validated_http_completed',
      tenantId: tenantPackFixture.tenantId,
      type: 'RUN_COMPLETED',
      createdAt: '2026-03-28T11:40:00.000Z',
      summary: 'Synthetic completed run.',
      metadata: {
        durationMs: 4000,
        schemaValidationPassed: true,
      },
    });
    await store.createJob(analysisJobRecordSchema.parse({
      jobId: 'validated_http_failed',
      status: 'FAILED',
      tenantId: tenantPackFixture.tenantId,
      conversationId: 'validated_http_failed_conversation',
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
      error: {
        message: 'Synthetic failed run.',
      },
    }));
    await store.appendRunEvent({
      eventId: 'validated_http_failed_terminal',
      runId: 'validated_http_failed',
      tenantId: tenantPackFixture.tenantId,
      type: 'RUN_FAILED',
      createdAt: '2026-03-28T11:40:00.000Z',
      summary: 'Synthetic failed run.',
      metadata: {
        durationMs: 12000,
        failureKind: 'SCHEMA_INVALID',
        schemaValidationPassed: false,
      },
    });

    const server = await startConversationIntelligenceServer(service, {
      port: 0,
      auth: {
        mode: 'api_key',
        apiKeys: [
          {
            token: 'token-validation',
            tenantId: tenantPackFixture.tenantId,
            principalId: 'svc_validation',
          },
        ],
      },
      tenantPacks,
      tenantAdminConfigs,
      modelValidation: {
        service: validation,
        reviewedExports,
      },
    });
    servers.push(server);
    const baseUrl = getBaseUrl(server);
    const headers = {
      authorization: 'Bearer token-validation',
      'content-type': 'application/json',
    };

    const exportResponse = await fetch(`${baseUrl}/v1/model-validation/export-reviewed-runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        useCase: tenantPackFixture.useCase,
        packVersion: 'support-v2',
        requireAnalystSentiment: true,
      }),
    });
    expect(exportResponse.status).toBe(200);
    const exportNdjson = await exportResponse.text();
    expect(exportNdjson).toContain('[PII:EMAIL]');
    expect(exportNdjson).toContain('validated_http_completed');

    const refreshResponse = await fetch(`${baseUrl}/v1/model-validation/refresh-reviewed-exports`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        useCase: tenantPackFixture.useCase,
        force: true,
        requireAnalystSentiment: true,
      }),
    });
    expect(refreshResponse.status).toBe(200);
    const refreshBody = await refreshResponse.json();
    expect(refreshBody.results).toHaveLength(1);

    const datasetsResponse = await fetch(`${baseUrl}/v1/model-validation/reviewed-datasets?useCase=${encodeURIComponent(tenantPackFixture.useCase)}`, {
      headers: {
        authorization: 'Bearer token-validation',
      },
    });
    expect(datasetsResponse.status).toBe(200);
    const datasetsBody = await datasetsResponse.json();
    expect(datasetsBody.scopes).toHaveLength(1);
    expect(datasetsBody.scopes[0].recordCount).toBe(1);
    expect(datasetsBody.scopes[0].analystSentimentCount).toBe(1);
    expect(datasetsBody.scopes[0].byQueue.support_voice).toBe(1);

    const runResponse = await fetch(`${baseUrl}/v1/model-validation/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        useCase: tenantPackFixture.useCase,
        force: true,
      }),
    });
    expect(runResponse.status).toBe(200);
    const runBody = await runResponse.json();
    expect(runBody.reports).toHaveLength(1);
    expect(runBody.reports[0].alerts.map((alert: { kind: string }) => alert.kind)).toEqual(expect.arrayContaining([
      'CANARY_REJECTED',
      'FAILURE_RATE_HIGH',
      'SCHEMA_VALID_RATE_LOW',
      'LATENCY_HIGH',
      'SCORE_DRIFT_HIGH',
    ]));
    expect(runBody.reports[0].liveMetrics.schemaValidRate).toBe(0.5);
    expect(runBody.reports[0].liveMetrics.averageProcessingDurationMs).toBe(8000);
    expect(runBody.reports[0].liveMetrics.byEngagementType.CALL.runCount).toBe(2);
    expect(runBody.reports[0].liveMetrics.byQueue.support_voice.runCount).toBe(2);
    expect(runBody.reports[0].liveMetrics.byTranscriptLengthBucket.SHORT.runCount).toBe(2);

    const reportsResponse = await fetch(`${baseUrl}/v1/model-validation/reports?useCase=${encodeURIComponent(tenantPackFixture.useCase)}&packVersion=support-v2`, {
      headers: {
        authorization: 'Bearer token-validation',
      },
    });
    expect(reportsResponse.status).toBe(200);
    const reportsBody = await reportsResponse.json();
    expect(reportsBody.reports).toHaveLength(1);

    const recommendationResponse = await fetch(`${baseUrl}/v1/model-validation/recommend-thresholds?useCase=${encodeURIComponent(tenantPackFixture.useCase)}&packVersion=support-v2`, {
      headers: {
        authorization: 'Bearer token-validation',
      },
    });
    expect(recommendationResponse.status).toBe(200);
    const recommendationBody = await recommendationResponse.json();
    expect(recommendationBody.recommendedThresholds.minimumSchemaValidRate).toBeGreaterThanOrEqual(0.9);
    expect(recommendationBody.observedLiveMetrics.byEngagementType.CALL.runCount).toBe(2);
    expect(recommendationBody.observedLiveMetrics.byQueue.support_voice.runCount).toBe(2);
    expect(recommendationBody.currentThresholds.byQueue.support_voice).toBeDefined();
    expect(recommendationBody.currentThresholds.byTranscriptLengthBucket.SHORT).toBeDefined();

    const applyResponse = await fetch(`${baseUrl}/v1/model-validation/apply-recommended-thresholds`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        useCase: tenantPackFixture.useCase,
        packVersion: 'support-v2',
        nightlyIntervalMinutes: 1440,
        minimumRunCount: 1,
        minimumReviewedSampleSize: 1,
        autoApply: true,
      }),
    });
    expect(applyResponse.status).toBe(200);
    const applyBody = await applyResponse.json();
    expect(applyBody.applied).toBe(true);
    expect(applyBody.validationMonitoring.minimumIntervalMinutes).toBe(1440);
    expect(applyBody.validationMonitoring.recommendations.autoApply).toBe(true);
    expect(applyBody.validationMonitoring.recommendations.lastAppliedPackVersion).toBe('support-v2');

    const alertsResponse = await fetch(`${baseUrl}/v1/model-validation/alerts?useCase=${encodeURIComponent(tenantPackFixture.useCase)}&packVersion=support-v2`, {
      headers: {
        authorization: 'Bearer token-validation',
      },
    });
    expect(alertsResponse.status).toBe(200);
    const alertsBody = await alertsResponse.json();
    expect(alertsBody.alerts.map((alert: { kind: string }) => alert.kind)).toEqual(expect.arrayContaining([
      'CANARY_REJECTED',
      'FAILURE_RATE_HIGH',
      'SCHEMA_VALID_RATE_LOW',
      'LATENCY_HIGH',
      'SCORE_DRIFT_HIGH',
    ]));
    expect(alertsBody.alerts.some((alert: { metadata?: Record<string, unknown>; kind: string }) => alert.metadata?.queue === 'support_voice' && alert.kind === 'SCORE_DRIFT_HIGH')).toBe(true);
  });
});
