import { randomUUID } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import { lstat, readFile, readdir } from 'fs/promises';
import { createGunzip, gunzipSync } from 'zlib';
import { join, resolve } from 'path';
import { createInterface } from 'readline';
import {
  AnalysisJobRecord,
  ModelValidationAlert,
  ModelValidationReport,
  ModelValidationThresholdApplyRequest,
  ModelValidationThresholdApplyResponse,
  ModelValidationThresholdRecommendationRequest,
  ModelValidationThresholdRecommendationResponse,
  ModelValidationRunRequest,
  ModelValidationRunResponse,
  ReviewedDatasetInventoryListResponse,
  ReviewedDatasetInventoryScope,
  ReviewedRunExportRecord,
  ReviewedRunExportRequest,
  modelValidationAlertListResponseSchema,
  modelValidationReportListResponseSchema,
  modelValidationThresholdApplyRequestSchema,
  modelValidationThresholdApplyResponseSchema,
  modelValidationRunResponseSchema,
  modelValidationThresholdRecommendationRequestSchema,
  modelValidationThresholdRecommendationResponseSchema,
  modelValidationThresholdOverrideSchema,
  modelValidationThresholdsSchema,
  reviewedDatasetCoverageRequirementsSchema,
  reviewedDatasetInventoryListResponseSchema,
  reviewedRunExportManifestSchema,
  reviewedRunExportRecordSchema,
  reviewedRunExportRequestSchema,
  reviewedRunExportResponseSchema,
} from '../contracts';
import { TenantAdminConfigRegistry } from '../admin/file-tenant-admin-config-registry';
import {
  ReviewedSentimentValidationSummary,
  runReviewedSentimentValidationFromSamples,
  summarizeReviewedSentimentValidation,
} from '../evals/run-reviewed-sentiment-validation';
import {
  RuntimeObservability,
  noopRuntimeObservability,
} from '../observability/runtime-observability';
import { TenantPackRegistry } from '../packs/file-tenant-pack-registry';
import { maskAnalysisRequest } from '../pii/masking';
import { ReviewedSentimentOutcomeSample } from '../sentiment/scoring';
import {
  ModelValidationReportFilters,
  ModelValidationReportStore,
} from '../validation/file-model-validation-report-store';
import { bucketTranscriptLength, deriveTranscriptStats } from '../validation/transcript-stats';
import { ConversationIntelligenceService } from './conversation-intelligence-service';
import { ValidationAlertNotifier } from './model-validation-alert-notifier';

export interface ExportReviewedRunsResult {
  response: ReturnType<typeof reviewedRunExportResponseSchema.parse>;
  records: ReviewedRunExportRecord[];
  ndjson: string;
}

export interface ModelValidationBatchRunResult extends ModelValidationRunResponse {}

export interface ApplyConfiguredThresholdRecommendationsResult {
  generatedAt: string;
  results: ModelValidationThresholdApplyResponse[];
  skipped: Array<{
    tenantId: string;
    useCase: string;
    reason: string;
  }>;
}

interface ReviewedDatasetFileDescriptor {
  path: string;
  snapshot: boolean;
}

export interface ModelValidationServiceOptions {
  service: ConversationIntelligenceService;
  tenantPacks: TenantPackRegistry;
  tenantAdminConfigs: TenantAdminConfigRegistry;
  reportStore: ModelValidationReportStore;
  reviewedDataDir?: string;
  reviewedDatasetReadinessOverrides?: Partial<{
    minimumRecordCount: number;
    minimumAnalystSentimentCount: number;
    maximumDatasetAgeHours?: number;
  }>;
  clock?: () => Date;
  observability?: RuntimeObservability;
  notifier?: ValidationAlertNotifier;
  cwd?: string;
}

export class ModelValidationService {
  private readonly service: ConversationIntelligenceService;
  private readonly tenantPacks: TenantPackRegistry;
  private readonly tenantAdminConfigs: TenantAdminConfigRegistry;
  private readonly reportStore: ModelValidationReportStore;
  private readonly reviewedDataDir?: string;
  private readonly reviewedDatasetReadinessOverrides?: Partial<{
    minimumRecordCount: number;
    minimumAnalystSentimentCount: number;
    maximumDatasetAgeHours?: number;
  }>;
  private readonly clock: () => Date;
  private readonly observability: RuntimeObservability;
  private readonly notifier?: ValidationAlertNotifier;
  private readonly cwd: string;

  constructor(options: ModelValidationServiceOptions) {
    this.service = options.service;
    this.tenantPacks = options.tenantPacks;
    this.tenantAdminConfigs = options.tenantAdminConfigs;
    this.reportStore = options.reportStore;
    this.reviewedDataDir = options.reviewedDataDir;
    this.reviewedDatasetReadinessOverrides = options.reviewedDatasetReadinessOverrides;
    this.clock = options.clock ?? (() => new Date());
    this.observability = options.observability ?? noopRuntimeObservability;
    this.notifier = options.notifier;
    this.cwd = options.cwd ?? process.cwd();
  }

  async exportReviewedRuns(input: ReviewedRunExportRequest = {}): Promise<ExportReviewedRunsResult> {
    const parsed = reviewedRunExportRequestSchema.parse(input);
    const jobs = await this.service.listJobs(parsed.tenantId);
    const records: ReviewedRunExportRecord[] = [];
    let skippedCount = 0;

    for (const job of jobs) {
      const record = this.toReviewedRunExportRecord(job, parsed);
      if (!record) {
        skippedCount += 1;
        continue;
      }
      records.push(record);
    }

    records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    return {
      response: reviewedRunExportResponseSchema.parse({
        generatedAt: this.clock().toISOString(),
        exportedCount: records.length,
        skippedCount,
      }),
      records,
      ndjson: records.map((record) => JSON.stringify(record)).join('\n'),
    };
  }

  async runConfiguredValidations(input: ModelValidationRunRequest = {}): Promise<ModelValidationBatchRunResult> {
    const generatedAt = this.clock().toISOString();
    const configs = await this.tenantAdminConfigs.list();
    const filteredConfigs = configs.filter((config) => {
      if (input.tenantId && config.tenantId !== input.tenantId) {
        return false;
      }
      if (input.useCase && config.useCase !== input.useCase) {
        return false;
      }
      return true;
    });

    const reports: ModelValidationReport[] = [];
    const skipped: Array<{ tenantId: string; useCase: string; reason: string }> = [];

    for (const config of filteredConfigs) {
      if (!config.validationMonitoring.enabled && !input.force) {
        skipped.push({
          tenantId: config.tenantId,
          useCase: config.useCase,
          reason: 'Validation monitoring is disabled for this tenant scope.',
        });
        continue;
      }

      const latestScopeReport = await this.reportStore.getLatestReport({
        tenantId: config.tenantId,
        useCase: config.useCase,
      });

      if (
        !input.force
        && latestScopeReport
        && this.minutesSince(latestScopeReport.generatedAt) < config.validationMonitoring.minimumIntervalMinutes
      ) {
        skipped.push({
          tenantId: config.tenantId,
          useCase: config.useCase,
          reason: `Validation ran too recently; wait at least ${config.validationMonitoring.minimumIntervalMinutes} minutes between runs.`,
        });
        continue;
      }

      const reviewedDataset = await this.buildReviewedDatasetSummary(
        config.tenantId,
        config.useCase,
        config.validationMonitoring.reviewedDatasetReadiness,
      );
      this.recordReviewedDatasetMetrics(config.tenantId, config.useCase, reviewedDataset);

      if (!input.force && !reviewedDataset.ready) {
        skipped.push({
          tenantId: config.tenantId,
          useCase: config.useCase,
          reason: `Reviewed dataset readiness failed: ${reviewedDataset.coverageFailures.join(' ')}`,
        });
        continue;
      }

      reports.push(...await this.runScope({
        tenantId: config.tenantId,
        useCase: config.useCase,
        reviewedDataset,
      }));
    }

    return modelValidationRunResponseSchema.parse({
      generatedAt,
      reports,
      skipped,
    });
  }

  async listReports(filters: ModelValidationReportFilters = {}): Promise<ReturnType<typeof modelValidationReportListResponseSchema.parse>> {
    return modelValidationReportListResponseSchema.parse({
      reports: await this.reportStore.listReports(filters),
    });
  }

  async listAlerts(filters: ModelValidationReportFilters = {}): Promise<ReturnType<typeof modelValidationAlertListResponseSchema.parse>> {
    return modelValidationAlertListResponseSchema.parse({
      alerts: await this.reportStore.listAlerts(filters),
    });
  }

  async listReviewedDatasets(filters: {
    tenantId?: string;
    useCase?: string;
  } = {}): Promise<ReviewedDatasetInventoryListResponse> {
    const generatedAt = this.clock().toISOString();
    const scopes = await this.resolveReviewedDatasetScopes(filters);
    return reviewedDatasetInventoryListResponseSchema.parse({
      generatedAt,
      scopes,
    });
  }

  async recommendThresholds(
    input: ModelValidationThresholdRecommendationRequest,
  ): Promise<ModelValidationThresholdRecommendationResponse> {
    const parsed = modelValidationThresholdRecommendationRequestSchema.parse(input);
    if (!parsed.tenantId || !parsed.useCase) {
      throw new Error('tenantId and useCase are required for threshold recommendations.');
    }

    const config = await this.tenantAdminConfigs.get(parsed.tenantId, parsed.useCase);
    const currentThresholds = modelValidationThresholdsSchema.parse(config.validationMonitoring.thresholds);
    const now = this.clock().toISOString();
    const windowStartedAt = this.windowStart(config.validationMonitoring.evaluationWindowHours, now);
    const allJobs = (await this.service.listJobs(parsed.tenantId)).filter((job) => (
      job.useCase === parsed.useCase
      && job.createdAt >= windowStartedAt
      && job.createdAt <= now
      && (!parsed.packVersion || this.packVersionForJob(job) === parsed.packVersion)
    ));
    const reviewedRecords = (await this.loadReviewedExportRecords(parsed.tenantId, parsed.useCase)).filter((record) => (
      record.createdAt >= windowStartedAt
      && record.createdAt <= now
      && (!parsed.packVersion || record.packVersion === parsed.packVersion)
    ));
    const liveMetrics = await this.computeLiveMetrics(allJobs);
    const reviewedValidation = this.computeReviewedValidation(reviewedRecords);
    const reviewedSummary = reviewedValidation?.summary ?? null;
    const recommendedThresholds = this.deriveRecommendedThresholds(
      currentThresholds,
      liveMetrics,
      reviewedValidation,
      config.validationMonitoring.recommendations,
    );

    return modelValidationThresholdRecommendationResponseSchema.parse({
      generatedAt: now,
      tenantId: parsed.tenantId,
      useCase: parsed.useCase,
      packVersion: parsed.packVersion,
      currentThresholds,
      recommendedThresholds,
      observedLiveMetrics: {
        runCount: liveMetrics.runCount,
        failureRate: liveMetrics.failureRate,
        reviewRate: liveMetrics.reviewRate,
        uncertainRate: liveMetrics.uncertainRate,
        schemaValidRate: liveMetrics.schemaValidRate,
        averageProcessingDurationMs: liveMetrics.averageProcessingDurationMs,
        p95ProcessingDurationMs: liveMetrics.p95ProcessingDurationMs,
        byEngagementType: liveMetrics.byEngagementType,
        byQueue: liveMetrics.byQueue,
        byTranscriptLengthBucket: liveMetrics.byTranscriptLengthBucket,
      },
      observedReviewedMetrics: reviewedValidation ? {
        total: reviewedValidation.summary.total,
        averageDeltaScore100: this.round(reviewedValidation.summary.averageDeltaScore100, 2),
        averageDeltaScore5: this.round(reviewedValidation.summary.averageDeltaScore5, 2),
        exactScore5MatchRate: reviewedValidation.summary.total > 0
          ? this.round(reviewedValidation.summary.exactScore5Matches / reviewedValidation.summary.total, 4)
          : 0,
        withinFivePointsRate: reviewedValidation.summary.total > 0
          ? this.round(reviewedValidation.summary.withinFivePointsScore100 / reviewedValidation.summary.total, 4)
          : 0,
        byEngagementType: Object.fromEntries(
          Object.entries(reviewedValidation.summary.byEngagementType).map(([engagementType, bucket]) => [
            engagementType,
            {
              total: bucket.total,
              averageDeltaScore100: this.round(bucket.averageDeltaScore100, 2),
              averageDeltaScore5: this.round(bucket.averageDeltaScore5, 2),
              exactScore5Matches: bucket.exactScore5Matches,
              exactScore5MatchRate: bucket.total > 0 ? this.round(bucket.exactScore5Matches / bucket.total, 4) : 0,
              withinFivePointsScore100: bucket.withinFivePointsScore100,
              withinFivePointsRate: bucket.total > 0 ? this.round(bucket.withinFivePointsScore100 / bucket.total, 4) : 0,
              correctedCount: bucket.correctedCount,
            },
          ]),
        ),
        byQueue: this.formatReviewedBreakdown(reviewedValidation.byQueue),
        byTranscriptLengthBucket: this.formatReviewedBreakdown(reviewedValidation.byTranscriptLengthBucket),
      } : undefined,
      notes: this.recommendationNotes(
        liveMetrics,
        reviewedValidation,
        config.validationMonitoring.recommendations,
      ),
    });
  }

  async applyRecommendedThresholds(
    input: ModelValidationThresholdApplyRequest,
  ): Promise<ModelValidationThresholdApplyResponse> {
    const parsed = modelValidationThresholdApplyRequestSchema.parse(input);
    if (!parsed.tenantId || !parsed.useCase) {
      throw new Error('tenantId and useCase are required to apply validation thresholds.');
    }

    const generatedAt = this.clock().toISOString();
    const config = await this.tenantAdminConfigs.get(parsed.tenantId, parsed.useCase);
    const recommendation = await this.recommendThresholds({
      tenantId: parsed.tenantId,
      useCase: parsed.useCase,
      packVersion: parsed.packVersion,
    });
    const previousThresholds = modelValidationThresholdsSchema.parse(config.validationMonitoring.thresholds);
    const insufficientReasons: string[] = [];
    const reviewedTotal = recommendation.observedReviewedMetrics?.total ?? 0;

    if (recommendation.observedLiveMetrics.runCount < parsed.minimumRunCount) {
      insufficientReasons.push(
        `Observed live run count ${recommendation.observedLiveMetrics.runCount} is below minimum ${parsed.minimumRunCount}.`,
      );
    }
    if (reviewedTotal < parsed.minimumReviewedSampleSize) {
      insufficientReasons.push(
        `Observed reviewed sample size ${reviewedTotal} is below minimum ${parsed.minimumReviewedSampleSize}.`,
      );
    }

    const applied = parsed.force || insufficientReasons.length === 0;
    const recommendationsPolicy = {
      ...config.validationMonitoring.recommendations,
      autoApply: parsed.autoApply,
      minimumIntervalMinutes: parsed.nightlyIntervalMinutes,
      minimumRunCount: parsed.minimumRunCount,
      minimumReviewedSampleSize: parsed.minimumReviewedSampleSize,
      minimumRunCountPerEngagementType: parsed.minimumRunCountPerEngagementType,
      minimumReviewedSampleSizePerEngagementType: parsed.minimumReviewedSampleSizePerEngagementType,
      minimumRunCountPerQueue: parsed.minimumRunCountPerQueue,
      minimumReviewedSampleSizePerQueue: parsed.minimumReviewedSampleSizePerQueue,
      minimumRunCountPerTranscriptLengthBucket: parsed.minimumRunCountPerTranscriptLengthBucket,
      minimumReviewedSampleSizePerTranscriptLengthBucket: parsed.minimumReviewedSampleSizePerTranscriptLengthBucket,
      lastAppliedAt: applied
        ? generatedAt
        : config.validationMonitoring.recommendations.lastAppliedAt,
      lastAppliedPackVersion: applied
        ? recommendation.packVersion
        : config.validationMonitoring.recommendations.lastAppliedPackVersion,
    };

    const nextConfig = await this.tenantAdminConfigs.set({
      ...config,
      updatedAt: generatedAt,
      validationMonitoring: {
        ...config.validationMonitoring,
        enabled: parsed.enableValidationMonitoring || config.validationMonitoring.enabled,
        minimumIntervalMinutes: parsed.nightlyIntervalMinutes,
        evaluationWindowHours: parsed.evaluationWindowHours ?? config.validationMonitoring.evaluationWindowHours,
        thresholds: applied ? recommendation.recommendedThresholds : previousThresholds,
        recommendations: recommendationsPolicy,
      },
    });

    return modelValidationThresholdApplyResponseSchema.parse({
      generatedAt,
      tenantId: parsed.tenantId,
      useCase: parsed.useCase,
      packVersion: recommendation.packVersion,
      applied,
      reason: applied ? undefined : insufficientReasons.join(' '),
      previousThresholds,
      appliedThresholds: nextConfig.validationMonitoring.thresholds,
      validationMonitoring: nextConfig.validationMonitoring,
      recommendation,
    });
  }

  async applyConfiguredThresholdRecommendations(input: {
    tenantId?: string;
    useCase?: string;
    force?: boolean;
  } = {}): Promise<ApplyConfiguredThresholdRecommendationsResult> {
    const generatedAt = this.clock().toISOString();
    const results: ModelValidationThresholdApplyResponse[] = [];
    const skipped: ApplyConfiguredThresholdRecommendationsResult['skipped'] = [];
    const configs = await this.tenantAdminConfigs.list();

    for (const config of configs) {
      if (input.tenantId && config.tenantId !== input.tenantId) {
        continue;
      }
      if (input.useCase && config.useCase !== input.useCase) {
        continue;
      }

      const policy = config.validationMonitoring.recommendations;
      if (!policy.autoApply && !input.force) {
        skipped.push({
          tenantId: config.tenantId,
          useCase: config.useCase,
          reason: 'Automatic threshold application is disabled for this tenant scope.',
        });
        continue;
      }

      if (
        !input.force
        && policy.lastAppliedAt
        && this.minutesSince(policy.lastAppliedAt) < policy.minimumIntervalMinutes
      ) {
        skipped.push({
          tenantId: config.tenantId,
          useCase: config.useCase,
          reason: `Threshold recommendations were applied too recently; wait at least ${policy.minimumIntervalMinutes} minutes between auto-apply runs.`,
        });
        continue;
      }

      results.push(await this.applyRecommendedThresholds({
        tenantId: config.tenantId,
        useCase: config.useCase,
        force: input.force ?? false,
        enableValidationMonitoring: config.validationMonitoring.enabled,
        nightlyIntervalMinutes: config.validationMonitoring.minimumIntervalMinutes,
        evaluationWindowHours: config.validationMonitoring.evaluationWindowHours,
        minimumRunCount: policy.minimumRunCount,
        minimumReviewedSampleSize: policy.minimumReviewedSampleSize,
        minimumRunCountPerEngagementType: policy.minimumRunCountPerEngagementType,
        minimumReviewedSampleSizePerEngagementType: policy.minimumReviewedSampleSizePerEngagementType,
        minimumRunCountPerQueue: policy.minimumRunCountPerQueue,
        minimumReviewedSampleSizePerQueue: policy.minimumReviewedSampleSizePerQueue,
        minimumRunCountPerTranscriptLengthBucket: policy.minimumRunCountPerTranscriptLengthBucket,
        minimumReviewedSampleSizePerTranscriptLengthBucket: policy.minimumReviewedSampleSizePerTranscriptLengthBucket,
        autoApply: policy.autoApply,
      }));
    }

    return {
      generatedAt,
      results,
      skipped,
    };
  }

  async runScope(input: {
    tenantId: string;
    useCase: string;
    packVersion?: string;
    reviewedDataset?: Awaited<ReturnType<ModelValidationService['buildReviewedDatasetSummary']>>;
  }): Promise<ModelValidationReport[]> {
    const config = await this.tenantAdminConfigs.get(input.tenantId, input.useCase);
    const thresholds = modelValidationThresholdsSchema.parse(config.validationMonitoring.thresholds);
    const now = this.clock().toISOString();
    const windowStartedAt = this.windowStart(config.validationMonitoring.evaluationWindowHours, now);
    const allJobs = (await this.service.listJobs(input.tenantId)).filter((job) => (
      job.useCase === input.useCase
      && job.createdAt >= windowStartedAt
      && job.createdAt <= now
    ));
    const reviewedRecords = await this.loadReviewedExportRecords(input.tenantId, input.useCase);
    const packVersions = new Set<string>();

    for (const job of allJobs) {
      const packVersion = this.packVersionForJob(job);
      if (packVersion) {
        packVersions.add(packVersion);
      }
    }

    for (const record of reviewedRecords) {
      if (record.packVersion) {
        packVersions.add(record.packVersion);
      }
    }

    if (input.packVersion) {
      packVersions.add(input.packVersion);
    }

    if (!packVersions.size) {
      packVersions.add('_all');
    }

    const reports: ModelValidationReport[] = [];

    for (const packVersionKey of Array.from(packVersions).sort()) {
      const packVersion = packVersionKey === '_all' ? undefined : packVersionKey;
      if (input.packVersion && packVersion !== input.packVersion) {
        continue;
      }

      const jobs = allJobs.filter((job) => (packVersion ? this.packVersionForJob(job) === packVersion : true));
      const records = reviewedRecords.filter((record) => (
        record.createdAt >= windowStartedAt
        && record.createdAt <= now
        && (packVersion ? record.packVersion === packVersion : true)
      ));
      const report = await this.buildReport({
        tenantId: input.tenantId,
        useCase: input.useCase,
        packVersion,
        thresholds,
        jobs,
        reviewedRecords: records,
        windowStartedAt,
        windowEndedAt: now,
        reviewedDataset: input.reviewedDataset
          ?? await this.buildReviewedDatasetSummary(
            input.tenantId,
            input.useCase,
            config.validationMonitoring.reviewedDatasetReadiness,
          ),
      });
      const savedReport = await this.reportStore.saveReport(report);
      this.recordValidationReportMetrics(savedReport);
      await this.notifyReport(savedReport);
      reports.push(savedReport);
    }

    return reports.sort((left, right) => {
      const byPack = (left.packVersion ?? '').localeCompare(right.packVersion ?? '');
      if (byPack !== 0) {
        return byPack;
      }
      return right.generatedAt.localeCompare(left.generatedAt);
    });
  }

  private async buildReport(input: {
    tenantId: string;
    useCase: string;
    packVersion?: string;
    thresholds: ReturnType<typeof modelValidationThresholdsSchema.parse>;
    jobs: AnalysisJobRecord[];
    reviewedRecords: ReviewedRunExportRecord[];
    windowStartedAt: string;
    windowEndedAt: string;
    reviewedDataset: Awaited<ReturnType<ModelValidationService['buildReviewedDatasetSummary']>>;
  }): Promise<ModelValidationReport> {
    const generatedAt = this.clock().toISOString();
    const reportId = randomUUID();
    const liveMetrics = await this.computeLiveMetrics(input.jobs);
    const reviewedValidation = this.computeReviewedValidation(input.reviewedRecords);
    const reviewedSummary = reviewedValidation?.summary ?? null;
    const previous = await this.reportStore.getLatestReport({
      tenantId: input.tenantId,
      useCase: input.useCase,
      packVersion: input.packVersion,
    });
    const alerts = await this.buildAlerts({
      reportId,
      generatedAt,
      tenantId: input.tenantId,
      useCase: input.useCase,
      packVersion: input.packVersion,
      thresholds: input.thresholds,
      liveMetrics,
      reviewedSummary,
      reviewedByQueue: reviewedValidation?.byQueue ?? {},
      reviewedByTranscriptLengthBucket: reviewedValidation?.byTranscriptLengthBucket ?? {},
    });

    const report = {
      reportId,
      tenantId: input.tenantId,
      useCase: input.useCase,
      packVersion: input.packVersion,
      generatedAt,
      windowStartedAt: input.windowStartedAt,
      windowEndedAt: input.windowEndedAt,
      thresholds: input.thresholds,
      liveMetrics,
      reviewedMetrics: reviewedValidation ? {
        total: reviewedValidation.summary.total,
        averageDeltaScore100: Number(reviewedValidation.summary.averageDeltaScore100.toFixed(2)),
        averageDeltaScore5: Number(reviewedValidation.summary.averageDeltaScore5.toFixed(2)),
        maxDeltaScore100: reviewedValidation.summary.maxDeltaScore100,
        maxDeltaScore5: reviewedValidation.summary.maxDeltaScore5,
        exactScore5Matches: reviewedValidation.summary.exactScore5Matches,
        exactScore5MatchRate: reviewedValidation.summary.total > 0
          ? Number((reviewedValidation.summary.exactScore5Matches / reviewedValidation.summary.total).toFixed(4))
          : 0,
        withinFivePointsScore100: reviewedValidation.summary.withinFivePointsScore100,
        withinFivePointsRate: reviewedValidation.summary.total > 0
          ? Number((reviewedValidation.summary.withinFivePointsScore100 / reviewedValidation.summary.total).toFixed(4))
          : 0,
        byReviewState: reviewedValidation.summary.byReviewState,
        byEngagementType: this.formatReviewedBreakdown(reviewedValidation.summary.byEngagementType),
        byQueue: this.formatReviewedBreakdown(reviewedValidation.byQueue),
        byTranscriptLengthBucket: this.formatReviewedBreakdown(reviewedValidation.byTranscriptLengthBucket),
        correctedCount: reviewedValidation.summary.correctedCount,
      } : undefined,
      regression: previous ? {
        previousReportId: previous.reportId,
        failureRateDelta: Number((liveMetrics.failureRate - previous.liveMetrics.failureRate).toFixed(4)),
        reviewRateDelta: Number((liveMetrics.reviewRate - previous.liveMetrics.reviewRate).toFixed(4)),
        uncertainRateDelta: Number((liveMetrics.uncertainRate - previous.liveMetrics.uncertainRate).toFixed(4)),
        schemaValidRateDelta: typeof liveMetrics.schemaValidRate === 'number' && typeof previous.liveMetrics.schemaValidRate === 'number'
          ? Number((liveMetrics.schemaValidRate - previous.liveMetrics.schemaValidRate).toFixed(4))
          : undefined,
        averageDeltaScore100Delta: reviewedValidation && previous.reviewedMetrics
          ? Number((reviewedValidation.summary.averageDeltaScore100 - previous.reviewedMetrics.averageDeltaScore100).toFixed(4))
          : undefined,
        averageProcessingDurationMsDelta: typeof liveMetrics.averageProcessingDurationMs === 'number'
          && typeof previous.liveMetrics.averageProcessingDurationMs === 'number'
          ? Number((liveMetrics.averageProcessingDurationMs - previous.liveMetrics.averageProcessingDurationMs).toFixed(2))
          : undefined,
        p95ProcessingDurationMsDelta: typeof liveMetrics.p95ProcessingDurationMs === 'number'
          && typeof previous.liveMetrics.p95ProcessingDurationMs === 'number'
          ? Number((liveMetrics.p95ProcessingDurationMs - previous.liveMetrics.p95ProcessingDurationMs).toFixed(2))
          : undefined,
      } : undefined,
      reviewedDataset: input.reviewedDataset,
      alerts,
    } satisfies ModelValidationReport;

    this.observability.incrementCounter('conversation_intelligence.model_validation.reports', 1, {
      tenant_id: input.tenantId,
      use_case: input.useCase,
      pack_version: input.packVersion,
      alert_count: alerts.length,
    });

    return report;
  }

  private recordValidationReportMetrics(report: ModelValidationReport): void {
    const baseAttributes = {
      tenant_id: report.tenantId,
      use_case: report.useCase,
      pack_version: report.packVersion ?? '_all',
    };

    this.observability.recordGauge('conversation_intelligence.model_validation.live_runs', report.liveMetrics.runCount, baseAttributes);
    this.observability.recordGauge('conversation_intelligence.model_validation.failure_rate', report.liveMetrics.failureRate, baseAttributes);
    this.observability.recordGauge('conversation_intelligence.model_validation.review_rate', report.liveMetrics.reviewRate, baseAttributes);
    this.observability.recordGauge('conversation_intelligence.model_validation.uncertain_rate', report.liveMetrics.uncertainRate, baseAttributes);
    this.observability.recordGauge('conversation_intelligence.model_validation.alert_count', report.alerts.length, baseAttributes);
    if (typeof report.liveMetrics.schemaValidRate === 'number') {
      this.observability.recordGauge('conversation_intelligence.model_validation.schema_valid_rate', report.liveMetrics.schemaValidRate, baseAttributes);
    }
    if (typeof report.liveMetrics.averageProcessingDurationMs === 'number') {
      this.observability.recordGauge(
        'conversation_intelligence.model_validation.average_processing_duration_ms',
        report.liveMetrics.averageProcessingDurationMs,
        baseAttributes,
      );
    }
    if (typeof report.liveMetrics.p95ProcessingDurationMs === 'number') {
      this.observability.recordGauge(
        'conversation_intelligence.model_validation.p95_processing_duration_ms',
        report.liveMetrics.p95ProcessingDurationMs,
        baseAttributes,
      );
    }

    if (report.reviewedMetrics) {
      this.observability.recordGauge('conversation_intelligence.model_validation.reviewed_samples', report.reviewedMetrics.total, baseAttributes);
      this.observability.recordGauge(
        'conversation_intelligence.model_validation.average_delta_score100',
        report.reviewedMetrics.averageDeltaScore100,
        baseAttributes,
      );
      this.observability.recordGauge(
        'conversation_intelligence.model_validation.exact_score5_match_rate',
        report.reviewedMetrics.exactScore5MatchRate,
        baseAttributes,
      );
      this.observability.recordGauge(
        'conversation_intelligence.model_validation.within_five_points_rate',
        report.reviewedMetrics.withinFivePointsRate,
        baseAttributes,
      );
    }

    this.recordScopedValidationMetrics('ENGAGEMENT_TYPE', report.liveMetrics.byEngagementType, report.reviewedMetrics?.byEngagementType, baseAttributes);
    this.recordScopedValidationMetrics('QUEUE', report.liveMetrics.byQueue, report.reviewedMetrics?.byQueue, baseAttributes);
    this.recordScopedValidationMetrics(
      'TRANSCRIPT_LENGTH_BUCKET',
      report.liveMetrics.byTranscriptLengthBucket,
      report.reviewedMetrics?.byTranscriptLengthBucket,
      baseAttributes,
    );

    if (report.reviewedDataset) {
      this.observability.recordGauge(
        'conversation_intelligence.reviewed_dataset.ready',
        report.reviewedDataset.ready ? 1 : 0,
        baseAttributes,
      );
      this.observability.recordGauge(
        'conversation_intelligence.reviewed_dataset.record_count',
        report.reviewedDataset.recordCount,
        baseAttributes,
      );
      this.observability.recordGauge(
        'conversation_intelligence.reviewed_dataset.analyst_sentiment_count',
        report.reviewedDataset.analystSentimentCount,
        baseAttributes,
      );
      this.observability.recordGauge(
        'conversation_intelligence.reviewed_dataset.file_count',
        report.reviewedDataset.fileCount,
        baseAttributes,
      );
      this.observability.recordGauge(
        'conversation_intelligence.reviewed_dataset.snapshot_count',
        report.reviewedDataset.snapshotCount,
        baseAttributes,
      );
      if (typeof report.reviewedDataset.datasetAgeHours === 'number') {
        this.observability.recordGauge(
          'conversation_intelligence.reviewed_dataset.age_hours',
          report.reviewedDataset.datasetAgeHours,
          baseAttributes,
        );
      }
      this.recordReviewedDatasetScopedMetrics('ENGAGEMENT_TYPE', report.reviewedDataset.byEngagementType, baseAttributes);
      this.recordReviewedDatasetScopedMetrics('QUEUE', report.reviewedDataset.byQueue, baseAttributes);
      this.recordReviewedDatasetScopedMetrics(
        'TRANSCRIPT_LENGTH_BUCKET',
        report.reviewedDataset.byTranscriptLengthBucket,
        baseAttributes,
      );
    }
  }

  private async buildAlerts(input: {
    reportId: string;
    generatedAt: string;
    tenantId: string;
    useCase: string;
    packVersion?: string;
    thresholds: ReturnType<typeof modelValidationThresholdsSchema.parse>;
    liveMetrics: Awaited<ReturnType<ModelValidationService['computeLiveMetrics']>>;
    reviewedSummary: ReviewedSentimentValidationSummary | null;
    reviewedByQueue: Record<string, {
      total: number;
      averageDeltaScore100: number;
      averageDeltaScore5: number;
      exactScore5Matches: number;
      withinFivePointsScore100: number;
      correctedCount: number;
    }>;
    reviewedByTranscriptLengthBucket: Record<string, {
      total: number;
      averageDeltaScore100: number;
      averageDeltaScore5: number;
      exactScore5Matches: number;
      withinFivePointsScore100: number;
      correctedCount: number;
    }>;
  }): Promise<ModelValidationAlert[]> {
    const alerts: ModelValidationAlert[] = [];

    const createAlert = (
      kind: ModelValidationAlert['kind'],
      severity: ModelValidationAlert['severity'],
      message: string,
      metricValue?: number,
      threshold?: number,
      metadata: Record<string, unknown> = {},
    ): void => {
      alerts.push({
        alertId: randomUUID(),
        reportId: input.reportId,
        tenantId: input.tenantId,
        useCase: input.useCase,
        packVersion: input.packVersion,
        createdAt: input.generatedAt,
        kind,
        severity,
        message,
        metricValue,
        threshold,
        metadata,
      });
    };

    if (input.liveMetrics.failureRate > input.thresholds.maximumFailureRate) {
      createAlert(
        'FAILURE_RATE_HIGH',
        'CRITICAL',
        `Failure rate ${input.liveMetrics.failureRate.toFixed(3)} is above threshold ${input.thresholds.maximumFailureRate.toFixed(3)}.`,
        input.liveMetrics.failureRate,
        input.thresholds.maximumFailureRate,
      );
    }

    if (input.liveMetrics.reviewRate > input.thresholds.maximumReviewRate) {
      createAlert(
        'REVIEW_RATE_HIGH',
        'WARNING',
        `Review rate ${input.liveMetrics.reviewRate.toFixed(3)} is above threshold ${input.thresholds.maximumReviewRate.toFixed(3)}.`,
        input.liveMetrics.reviewRate,
        input.thresholds.maximumReviewRate,
      );
    }

    if (input.liveMetrics.uncertainRate > input.thresholds.maximumUncertainRate) {
      createAlert(
        'UNCERTAIN_RATE_HIGH',
        'WARNING',
        `Uncertain rate ${input.liveMetrics.uncertainRate.toFixed(3)} is above threshold ${input.thresholds.maximumUncertainRate.toFixed(3)}.`,
        input.liveMetrics.uncertainRate,
        input.thresholds.maximumUncertainRate,
      );
    }

    if (
      typeof input.liveMetrics.schemaValidRate === 'number'
      && input.liveMetrics.schemaValidRate < input.thresholds.minimumSchemaValidRate
    ) {
      createAlert(
        'SCHEMA_VALID_RATE_LOW',
        'CRITICAL',
        `Schema-valid rate ${input.liveMetrics.schemaValidRate.toFixed(3)} is below threshold ${input.thresholds.minimumSchemaValidRate.toFixed(3)}.`,
        input.liveMetrics.schemaValidRate,
        input.thresholds.minimumSchemaValidRate,
      );
    }

    if (
      typeof input.liveMetrics.averageProcessingDurationMs === 'number'
      && input.liveMetrics.averageProcessingDurationMs > input.thresholds.maximumAverageProcessingDurationMs
    ) {
      createAlert(
        'LATENCY_HIGH',
        'WARNING',
        `Average processing duration ${input.liveMetrics.averageProcessingDurationMs.toFixed(0)}ms is above threshold ${input.thresholds.maximumAverageProcessingDurationMs.toFixed(0)}ms.`,
        input.liveMetrics.averageProcessingDurationMs,
        input.thresholds.maximumAverageProcessingDurationMs,
        {
          p95ProcessingDurationMs: input.liveMetrics.p95ProcessingDurationMs,
          maximumP95ProcessingDurationMs: input.thresholds.maximumP95ProcessingDurationMs,
        },
      );
    } else if (
      typeof input.liveMetrics.p95ProcessingDurationMs === 'number'
      && input.liveMetrics.p95ProcessingDurationMs > input.thresholds.maximumP95ProcessingDurationMs
    ) {
      createAlert(
        'LATENCY_HIGH',
        'WARNING',
        `P95 processing duration ${input.liveMetrics.p95ProcessingDurationMs.toFixed(0)}ms is above threshold ${input.thresholds.maximumP95ProcessingDurationMs.toFixed(0)}ms.`,
        input.liveMetrics.p95ProcessingDurationMs,
        input.thresholds.maximumP95ProcessingDurationMs,
        {
          averageProcessingDurationMs: input.liveMetrics.averageProcessingDurationMs,
          maximumAverageProcessingDurationMs: input.thresholds.maximumAverageProcessingDurationMs,
        },
      );
    }

    const canaryAlert = await this.canaryAlertForPack(
      input.tenantId,
      input.useCase,
      input.packVersion,
      input.generatedAt,
      input.reportId,
    );
    if (canaryAlert) {
      alerts.push(canaryAlert);
    }

    this.appendScopedAlerts({
      scopeType: 'ENGAGEMENT_TYPE',
      scopeKeys: Object.keys(input.thresholds.byEngagementType),
      thresholds: input.thresholds,
      liveBreakdown: input.liveMetrics.byEngagementType,
      reviewedBreakdown: input.reviewedSummary?.byEngagementType ?? {},
      createAlert,
    });
    this.appendScopedAlerts({
      scopeType: 'QUEUE',
      thresholds: input.thresholds,
      liveBreakdown: input.liveMetrics.byQueue,
      reviewedBreakdown: input.reviewedByQueue,
      createAlert,
    });
    this.appendScopedAlerts({
      scopeType: 'TRANSCRIPT_LENGTH_BUCKET',
      thresholds: input.thresholds,
      liveBreakdown: input.liveMetrics.byTranscriptLengthBucket,
      reviewedBreakdown: input.reviewedByTranscriptLengthBucket,
      createAlert,
    });

    if (!input.reviewedSummary) {
      return alerts;
    }

    if (input.reviewedSummary.total < input.thresholds.minimumReviewedSampleSize) {
      createAlert(
        'REVIEWED_SAMPLE_SIZE_LOW',
        'INFO',
        `Reviewed sample size ${input.reviewedSummary.total} is below threshold ${input.thresholds.minimumReviewedSampleSize}.`,
        input.reviewedSummary.total,
        input.thresholds.minimumReviewedSampleSize,
      );
      return alerts;
    }

    if (input.reviewedSummary.averageDeltaScore100 > input.thresholds.maximumAverageDeltaScore100) {
      createAlert(
        'SCORE_DRIFT_HIGH',
        'CRITICAL',
        `Average score100 drift ${input.reviewedSummary.averageDeltaScore100.toFixed(2)} is above threshold ${input.thresholds.maximumAverageDeltaScore100.toFixed(2)}.`,
        input.reviewedSummary.averageDeltaScore100,
        input.thresholds.maximumAverageDeltaScore100,
      );
    }

    const exactScore5MatchRate = input.reviewedSummary.total > 0
      ? input.reviewedSummary.exactScore5Matches / input.reviewedSummary.total
      : 0;
    const withinFivePointsRate = input.reviewedSummary.total > 0
      ? input.reviewedSummary.withinFivePointsScore100 / input.reviewedSummary.total
      : 0;

    if (
      input.reviewedSummary.averageDeltaScore5 > input.thresholds.maximumAverageDeltaScore5
      || exactScore5MatchRate < input.thresholds.minimumExactScore5MatchRate
      || withinFivePointsRate < input.thresholds.minimumWithinFivePointsRate
    ) {
      createAlert(
        'SCORE_BUCKET_MATCH_LOW',
        'WARNING',
        `Score bucket agreement is below threshold; exact score5 match ${exactScore5MatchRate.toFixed(3)}, within-five-points rate ${withinFivePointsRate.toFixed(3)}.`,
        exactScore5MatchRate,
        input.thresholds.minimumExactScore5MatchRate,
        {
          averageDeltaScore5: Number(input.reviewedSummary.averageDeltaScore5.toFixed(2)),
          withinFivePointsRate: Number(withinFivePointsRate.toFixed(4)),
          minimumWithinFivePointsRate: input.thresholds.minimumWithinFivePointsRate,
        },
      );
    }

    return alerts;
  }

  private async computeLiveMetrics(jobs: AnalysisJobRecord[]) {
    const runCount = jobs.length;
    const completedRuns = jobs.filter((job) => job.status === 'COMPLETED');
    const failedRuns = jobs.filter((job) => job.status === 'FAILED');
    const reviewCount = completedRuns.filter((job) => job.result?.review.state === 'NEEDS_REVIEW').length;
    const uncertainCount = completedRuns.filter((job) => job.result?.review.state === 'UNCERTAIN').length;
    const scoredRuns = completedRuns.filter((job) => typeof job.result?.overallEndUserSentiment?.score?.score100 === 'number');
    const averageScore100 = scoredRuns.length > 0
      ? Number((scoredRuns.reduce((sum, job) => sum + (job.result?.overallEndUserSentiment?.score?.score100 ?? 0), 0) / scoredRuns.length).toFixed(2))
      : undefined;
    const terminalJobs = jobs.filter((job) => job.status === 'COMPLETED' || job.status === 'FAILED');
    const runEventsByJob = new Map(await Promise.all(terminalJobs.map(async (job) => (
      [job.jobId, await this.service.listRunEvents(job.jobId)] as const
    ))));
    const processingDurationsMs: number[] = [];
    let schemaValidRuns = 0;
    let schemaInvalidRuns = 0;

    for (const job of terminalJobs) {
      const snapshot = runEventsByJob.get(job.jobId);
      const terminalEvent = this.terminalRunEvent(snapshot?.events ?? []);
      const durationMs = this.processingDurationMs(job, terminalEvent?.metadata ?? {});
      if (typeof durationMs === 'number') {
        processingDurationsMs.push(durationMs);
      }

      if (job.status === 'COMPLETED') {
        if (terminalEvent?.metadata?.schemaValidationPassed !== false) {
          schemaValidRuns += 1;
        }
        continue;
      }

      if (terminalEvent?.metadata?.failureKind === 'SCHEMA_INVALID') {
        schemaInvalidRuns += 1;
      }
    }

    const schemaValidatedRuns = schemaValidRuns + schemaInvalidRuns;
    const schemaValidRate = schemaValidatedRuns > 0
      ? this.round(schemaValidRuns / schemaValidatedRuns, 4)
      : undefined;
    const averageProcessingDurationMs = processingDurationsMs.length > 0
      ? this.round(processingDurationsMs.reduce((sum, value) => sum + value, 0) / processingDurationsMs.length, 2)
      : undefined;
    const p95ProcessingDurationMs = processingDurationsMs.length > 0
      ? this.round(this.percentile(processingDurationsMs, 0.95), 2)
      : undefined;
    const byEngagementType = this.computeLiveBreakdown(this.groupJobsByEngagementType(jobs), runEventsByJob);
    const byQueue = this.computeLiveBreakdown(this.groupJobsByQueue(jobs), runEventsByJob);
    const byTranscriptLengthBucket = this.computeLiveBreakdown(
      this.groupJobsByTranscriptLengthBucket(jobs),
      runEventsByJob,
    );

    return {
      runCount,
      completedRuns: completedRuns.length,
      failedRuns: failedRuns.length,
      reviewCount,
      uncertainCount,
      scoredRuns: scoredRuns.length,
      schemaValidatedRuns,
      schemaValidRuns,
      schemaInvalidRuns,
      failureRate: runCount > 0 ? Number((failedRuns.length / runCount).toFixed(4)) : 0,
      reviewRate: completedRuns.length > 0 ? Number((reviewCount / completedRuns.length).toFixed(4)) : 0,
      uncertainRate: completedRuns.length > 0 ? Number((uncertainCount / completedRuns.length).toFixed(4)) : 0,
      schemaValidRate,
      averageScore100,
      averageProcessingDurationMs,
      p95ProcessingDurationMs,
      byEngagementType,
      byQueue,
      byTranscriptLengthBucket,
    };
  }

  private appendScopedAlerts(input: {
    scopeType: 'ENGAGEMENT_TYPE' | 'QUEUE' | 'TRANSCRIPT_LENGTH_BUCKET';
    scopeKeys?: string[];
    thresholds: ReturnType<typeof modelValidationThresholdsSchema.parse>;
    liveBreakdown: Record<string, {
      runCount: number;
      failureRate: number;
      reviewRate: number;
      uncertainRate: number;
      schemaValidRate?: number;
      averageProcessingDurationMs?: number;
      p95ProcessingDurationMs?: number;
    }>;
    reviewedBreakdown: Record<string, {
      total: number;
      averageDeltaScore100: number;
      averageDeltaScore5: number;
      exactScore5Matches: number;
      withinFivePointsScore100: number;
      correctedCount: number;
    }>;
    createAlert: (
      kind: ModelValidationAlert['kind'],
      severity: ModelValidationAlert['severity'],
      message: string,
      metricValue?: number,
      threshold?: number,
      metadata?: Record<string, unknown>,
    ) => void;
  }) {
    const scopes = input.scopeKeys
      ? Array.from(new Set(input.scopeKeys))
      : Array.from(new Set([
        ...Object.keys(input.liveBreakdown),
        ...Object.keys(input.reviewedBreakdown),
        ...this.thresholdOverrideScopesForType(input.thresholds, input.scopeType),
      ]));

    for (const scope of scopes.sort()) {
      const scopedThresholds = this.thresholdsForScope(input.thresholds, input.scopeType, scope);
      const scopedLiveMetrics = input.liveBreakdown[scope];
      const scopedReviewedMetrics = input.reviewedBreakdown[scope];
      const prefix = `${this.scopeAlertPrefix(input.scopeType, scope)} `;
      const metadata = this.scopeAlertMetadata(input.scopeType, scope);

      if (scopedLiveMetrics) {
        if (scopedLiveMetrics.failureRate > scopedThresholds.maximumFailureRate) {
          input.createAlert(
            'FAILURE_RATE_HIGH',
            'CRITICAL',
            `${prefix}Failure rate ${scopedLiveMetrics.failureRate.toFixed(3)} is above threshold ${scopedThresholds.maximumFailureRate.toFixed(3)}.`,
            scopedLiveMetrics.failureRate,
            scopedThresholds.maximumFailureRate,
            metadata,
          );
        }

        if (scopedLiveMetrics.reviewRate > scopedThresholds.maximumReviewRate) {
          input.createAlert(
            'REVIEW_RATE_HIGH',
            'WARNING',
            `${prefix}Review rate ${scopedLiveMetrics.reviewRate.toFixed(3)} is above threshold ${scopedThresholds.maximumReviewRate.toFixed(3)}.`,
            scopedLiveMetrics.reviewRate,
            scopedThresholds.maximumReviewRate,
            metadata,
          );
        }

        if (scopedLiveMetrics.uncertainRate > scopedThresholds.maximumUncertainRate) {
          input.createAlert(
            'UNCERTAIN_RATE_HIGH',
            'WARNING',
            `${prefix}Uncertain rate ${scopedLiveMetrics.uncertainRate.toFixed(3)} is above threshold ${scopedThresholds.maximumUncertainRate.toFixed(3)}.`,
            scopedLiveMetrics.uncertainRate,
            scopedThresholds.maximumUncertainRate,
            metadata,
          );
        }

        if (
          typeof scopedLiveMetrics.schemaValidRate === 'number'
          && scopedLiveMetrics.schemaValidRate < scopedThresholds.minimumSchemaValidRate
        ) {
          input.createAlert(
            'SCHEMA_VALID_RATE_LOW',
            'CRITICAL',
            `${prefix}Schema-valid rate ${scopedLiveMetrics.schemaValidRate.toFixed(3)} is below threshold ${scopedThresholds.minimumSchemaValidRate.toFixed(3)}.`,
            scopedLiveMetrics.schemaValidRate,
            scopedThresholds.minimumSchemaValidRate,
            metadata,
          );
        }

        if (
          typeof scopedLiveMetrics.averageProcessingDurationMs === 'number'
          && scopedLiveMetrics.averageProcessingDurationMs > scopedThresholds.maximumAverageProcessingDurationMs
        ) {
          input.createAlert(
            'LATENCY_HIGH',
            'WARNING',
            `${prefix}Average processing duration ${scopedLiveMetrics.averageProcessingDurationMs.toFixed(0)}ms is above threshold ${scopedThresholds.maximumAverageProcessingDurationMs.toFixed(0)}ms.`,
            scopedLiveMetrics.averageProcessingDurationMs,
            scopedThresholds.maximumAverageProcessingDurationMs,
            {
              ...metadata,
              p95ProcessingDurationMs: scopedLiveMetrics.p95ProcessingDurationMs,
              maximumP95ProcessingDurationMs: scopedThresholds.maximumP95ProcessingDurationMs,
            },
          );
        } else if (
          typeof scopedLiveMetrics.p95ProcessingDurationMs === 'number'
          && scopedLiveMetrics.p95ProcessingDurationMs > scopedThresholds.maximumP95ProcessingDurationMs
        ) {
          input.createAlert(
            'LATENCY_HIGH',
            'WARNING',
            `${prefix}P95 processing duration ${scopedLiveMetrics.p95ProcessingDurationMs.toFixed(0)}ms is above threshold ${scopedThresholds.maximumP95ProcessingDurationMs.toFixed(0)}ms.`,
            scopedLiveMetrics.p95ProcessingDurationMs,
            scopedThresholds.maximumP95ProcessingDurationMs,
            {
              ...metadata,
              averageProcessingDurationMs: scopedLiveMetrics.averageProcessingDurationMs,
              maximumAverageProcessingDurationMs: scopedThresholds.maximumAverageProcessingDurationMs,
            },
          );
        }
      }

      if (!scopedReviewedMetrics) {
        if (scopedLiveMetrics && scopedLiveMetrics.runCount > 0) {
          input.createAlert(
            'REVIEWED_SAMPLE_SIZE_LOW',
            'INFO',
            `${prefix}Reviewed sample size 0 is below threshold ${scopedThresholds.minimumReviewedSampleSize}.`,
            0,
            scopedThresholds.minimumReviewedSampleSize,
            metadata,
          );
        }
        continue;
      }

      if (scopedReviewedMetrics.total < scopedThresholds.minimumReviewedSampleSize) {
        input.createAlert(
          'REVIEWED_SAMPLE_SIZE_LOW',
          'INFO',
          `${prefix}Reviewed sample size ${scopedReviewedMetrics.total} is below threshold ${scopedThresholds.minimumReviewedSampleSize}.`,
          scopedReviewedMetrics.total,
          scopedThresholds.minimumReviewedSampleSize,
          metadata,
        );
        continue;
      }

      if (scopedReviewedMetrics.averageDeltaScore100 > scopedThresholds.maximumAverageDeltaScore100) {
        input.createAlert(
          'SCORE_DRIFT_HIGH',
          'CRITICAL',
          `${prefix}Average score100 drift ${scopedReviewedMetrics.averageDeltaScore100.toFixed(2)} is above threshold ${scopedThresholds.maximumAverageDeltaScore100.toFixed(2)}.`,
          scopedReviewedMetrics.averageDeltaScore100,
          scopedThresholds.maximumAverageDeltaScore100,
          metadata,
        );
      }

      const scopedExactScore5MatchRate = scopedReviewedMetrics.total > 0
        ? scopedReviewedMetrics.exactScore5Matches / scopedReviewedMetrics.total
        : 0;
      const scopedWithinFivePointsRate = scopedReviewedMetrics.total > 0
        ? scopedReviewedMetrics.withinFivePointsScore100 / scopedReviewedMetrics.total
        : 0;
      if (
        scopedReviewedMetrics.averageDeltaScore5 > scopedThresholds.maximumAverageDeltaScore5
        || scopedExactScore5MatchRate < scopedThresholds.minimumExactScore5MatchRate
        || scopedWithinFivePointsRate < scopedThresholds.minimumWithinFivePointsRate
      ) {
        input.createAlert(
          'SCORE_BUCKET_MATCH_LOW',
          'WARNING',
          `${prefix}Score bucket agreement is below threshold; exact score5 match ${scopedExactScore5MatchRate.toFixed(3)}, within-five-points rate ${scopedWithinFivePointsRate.toFixed(3)}.`,
          scopedExactScore5MatchRate,
          scopedThresholds.minimumExactScore5MatchRate,
          {
            ...metadata,
            averageDeltaScore5: Number(scopedReviewedMetrics.averageDeltaScore5.toFixed(2)),
            withinFivePointsRate: Number(scopedWithinFivePointsRate.toFixed(4)),
            minimumWithinFivePointsRate: scopedThresholds.minimumWithinFivePointsRate,
          },
        );
      }
    }
  }

  private recordScopedValidationMetrics(
    scopeType: 'ENGAGEMENT_TYPE' | 'QUEUE' | 'TRANSCRIPT_LENGTH_BUCKET',
    liveBreakdown: Record<string, {
      runCount: number;
      failureRate: number;
      reviewRate: number;
      uncertainRate: number;
      schemaValidRate?: number;
      averageProcessingDurationMs?: number;
      p95ProcessingDurationMs?: number;
    }>,
    reviewedBreakdown: Record<string, {
      total: number;
      averageDeltaScore100: number;
      averageDeltaScore5: number;
      exactScore5MatchRate?: number;
      withinFivePointsRate?: number;
      exactScore5Matches: number;
      withinFivePointsScore100: number;
      correctedCount: number;
    }> | undefined,
    baseAttributes: Record<string, string>,
  ): void {
    const scopes = new Set([
      ...Object.keys(liveBreakdown),
      ...Object.keys(reviewedBreakdown ?? {}),
    ]);

    for (const scope of scopes) {
      const labels = {
        ...baseAttributes,
        scope_type: scopeType,
        scope_value: scope,
      };
      const liveBucket = liveBreakdown[scope];
      if (liveBucket) {
        this.observability.recordGauge('conversation_intelligence.model_validation.scope_live_runs', liveBucket.runCount, labels);
        this.observability.recordGauge('conversation_intelligence.model_validation.scope_failure_rate', liveBucket.failureRate, labels);
        this.observability.recordGauge('conversation_intelligence.model_validation.scope_review_rate', liveBucket.reviewRate, labels);
        this.observability.recordGauge('conversation_intelligence.model_validation.scope_uncertain_rate', liveBucket.uncertainRate, labels);
        if (typeof liveBucket.schemaValidRate === 'number') {
          this.observability.recordGauge('conversation_intelligence.model_validation.scope_schema_valid_rate', liveBucket.schemaValidRate, labels);
        }
      }

      const reviewedBucket = reviewedBreakdown?.[scope];
      if (reviewedBucket) {
        this.observability.recordGauge('conversation_intelligence.model_validation.scope_reviewed_samples', reviewedBucket.total, labels);
        this.observability.recordGauge(
          'conversation_intelligence.model_validation.scope_average_delta_score100',
          reviewedBucket.averageDeltaScore100,
          labels,
        );
        const exactScore5MatchRate = typeof reviewedBucket.exactScore5MatchRate === 'number'
          ? reviewedBucket.exactScore5MatchRate
          : (reviewedBucket.total > 0 ? reviewedBucket.exactScore5Matches / reviewedBucket.total : 0);
        const withinFivePointsRate = typeof reviewedBucket.withinFivePointsRate === 'number'
          ? reviewedBucket.withinFivePointsRate
          : (reviewedBucket.total > 0 ? reviewedBucket.withinFivePointsScore100 / reviewedBucket.total : 0);
        this.observability.recordGauge('conversation_intelligence.model_validation.scope_exact_score5_match_rate', exactScore5MatchRate, labels);
        this.observability.recordGauge('conversation_intelligence.model_validation.scope_within_five_points_rate', withinFivePointsRate, labels);
      }
    }
  }

  private recordReviewedDatasetMetrics(
    tenantId: string,
    useCase: string,
    dataset: Awaited<ReturnType<ModelValidationService['buildReviewedDatasetSummary']>>,
  ): void {
    const baseAttributes = {
      tenant_id: tenantId,
      use_case: useCase,
    };
    this.observability.recordGauge(
      'conversation_intelligence.reviewed_dataset.ready',
      dataset.ready ? 1 : 0,
      baseAttributes,
    );
    this.observability.recordGauge(
      'conversation_intelligence.reviewed_dataset.record_count',
      dataset.recordCount,
      baseAttributes,
    );
    this.observability.recordGauge(
      'conversation_intelligence.reviewed_dataset.analyst_sentiment_count',
      dataset.analystSentimentCount,
      baseAttributes,
    );
    this.observability.recordGauge(
      'conversation_intelligence.reviewed_dataset.coverage_failures',
      dataset.coverageFailures.length,
      baseAttributes,
    );
    if (typeof dataset.datasetAgeHours === 'number') {
      this.observability.recordGauge(
        'conversation_intelligence.reviewed_dataset.age_hours',
        dataset.datasetAgeHours,
        baseAttributes,
      );
    }
  }

  private recordReviewedDatasetScopedMetrics(
    scopeType: 'ENGAGEMENT_TYPE' | 'QUEUE' | 'TRANSCRIPT_LENGTH_BUCKET',
    counts: Record<string, number>,
    baseAttributes: Record<string, string>,
  ): void {
    for (const [scope, count] of Object.entries(counts)) {
      this.observability.recordGauge(
        'conversation_intelligence.reviewed_dataset.scope_records',
        count,
        {
          ...baseAttributes,
          scope_type: scopeType,
          scope_value: scope,
        },
      );
    }
  }

  private async buildReviewedDatasetSummary(
    tenantId: string,
    useCase: string,
    requirementsInput: {
      minimumRecordCount: number;
      minimumAnalystSentimentCount: number;
      maximumDatasetAgeHours?: number;
      byEngagementType?: Record<string, number>;
      byQueue?: Record<string, number>;
      byTranscriptLengthBucket?: Record<string, number>;
    },
  ) {
    const requirements = reviewedDatasetCoverageRequirementsSchema.parse({
      ...requirementsInput,
      ...this.reviewedDatasetReadinessOverrides,
      byEngagementType: requirementsInput.byEngagementType ?? {},
      byQueue: requirementsInput.byQueue ?? {},
      byTranscriptLengthBucket: requirementsInput.byTranscriptLengthBucket ?? {},
    });
    const scope = (await this.resolveReviewedDatasetScopes({ tenantId, useCase }))[0] ?? null;
    const coverageFailures: string[] = [];
    const latestUpdatedAtMillis = scope?.latestUpdatedAt ? Date.parse(scope.latestUpdatedAt) : Number.NaN;
    const datasetAgeHours = Number.isFinite(latestUpdatedAtMillis)
      ? this.round(Math.max(0, this.clock().getTime() - latestUpdatedAtMillis) / (60 * 60 * 1000), 2)
      : undefined;

    if (!scope) {
      coverageFailures.push('No reviewed dataset files were found for this tenant scope.');
      return {
        recordCount: 0,
        analystSentimentCount: 0,
        fileCount: 0,
        snapshotCount: 0,
        latestUpdatedAt: undefined,
        datasetAgeHours,
        byEngagementType: {},
        byQueue: {},
        byTranscriptLengthBucket: {},
        coverageRequirements: requirements,
        coverageFailures,
        ready: false,
      };
    }

    if (scope.recordCount < requirements.minimumRecordCount) {
      coverageFailures.push(
        `Reviewed record count ${scope.recordCount} is below minimum ${requirements.minimumRecordCount}.`,
      );
    }
    if (scope.analystSentimentCount < requirements.minimumAnalystSentimentCount) {
      coverageFailures.push(
        `Analyst sentiment count ${scope.analystSentimentCount} is below minimum ${requirements.minimumAnalystSentimentCount}.`,
      );
    }
    if (
      typeof requirements.maximumDatasetAgeHours === 'number'
      && typeof datasetAgeHours === 'number'
      && datasetAgeHours > requirements.maximumDatasetAgeHours
    ) {
      coverageFailures.push(
        `Reviewed dataset age ${datasetAgeHours.toFixed(2)}h exceeds maximum ${requirements.maximumDatasetAgeHours}h.`,
      );
    }

    this.appendCoverageFailures('engagement type', scope.byEngagementType, requirements.byEngagementType, coverageFailures);
    this.appendCoverageFailures('queue', scope.byQueue, requirements.byQueue, coverageFailures);
    this.appendCoverageFailures(
      'transcript length bucket',
      scope.byTranscriptLengthBucket,
      requirements.byTranscriptLengthBucket,
      coverageFailures,
    );

    return {
      recordCount: scope.recordCount,
      analystSentimentCount: scope.analystSentimentCount,
      fileCount: scope.fileCount,
      snapshotCount: scope.snapshotCount,
      latestUpdatedAt: scope.latestUpdatedAt,
      datasetAgeHours,
      byEngagementType: scope.byEngagementType,
      byQueue: scope.byQueue,
      byTranscriptLengthBucket: scope.byTranscriptLengthBucket,
      coverageRequirements: requirements,
      coverageFailures,
      ready: coverageFailures.length === 0,
    };
  }

  private appendCoverageFailures(
    scopeLabel: string,
    actual: Record<string, number>,
    required: Record<string, number>,
    failures: string[],
  ): void {
    for (const [scope, minimumCount] of Object.entries(required)) {
      const actualCount = actual[scope] ?? 0;
      if (actualCount < minimumCount) {
        failures.push(`${scopeLabel} ${scope} has ${actualCount} reviewed records; need at least ${minimumCount}.`);
      }
    }
  }

  private computeReviewedValidation(records: ReviewedRunExportRecord[]) {
    const samples = this.buildReviewedOutcomeSamples(records);
    if (samples.length === 0) {
      return null;
    }

    const results = runReviewedSentimentValidationFromSamples(samples);
    return {
      summary: summarizeReviewedSentimentValidation(results),
      byQueue: this.summarizeReviewedResultsBy(results, (result) => result.queue ?? 'UNSPECIFIED'),
      byTranscriptLengthBucket: this.summarizeReviewedResultsBy(
        results,
        (result) => result.transcriptLengthBucket ?? 'UNSPECIFIED',
      ),
    };
  }

  private buildReviewedOutcomeSamples(records: ReviewedRunExportRecord[]): ReviewedSentimentOutcomeSample[] {
    return records
      .filter((record) => Boolean(record.model && record.review.analystSentiment))
      .map((record) => {
        const transcriptStats = record.transcript
          ? deriveTranscriptStats(record.transcript)
          : undefined;
        return {
          runId: record.runId,
          tenantId: record.tenantId,
          useCase: record.useCase,
          source: 'review_export',
          engagementType: record.engagementType,
          queue: record.queue ?? this.stringMetadata(record.transcript?.metadata, 'queue'),
          transcriptTurnCount: record.transcriptTurnCount ?? transcriptStats?.transcriptTurnCount,
          transcriptCharacterCount: record.transcriptCharacterCount ?? transcriptStats?.transcriptCharacterCount,
          transcriptLengthBucket: record.transcriptLengthBucket
            ?? this.validTranscriptLengthBucket(this.stringMetadata(record.transcript?.metadata, 'transcriptLengthBucket'))
            ?? transcriptStats?.transcriptLengthBucket,
          sourceDataset: record.sourceDataset,
          datasetTrack: record.datasetTrack,
          name: record.runId,
          category: record.useCase,
          reviewedBy: record.review.analystSentiment?.reviewedById,
          reviewedAt: record.review.analystSentiment?.reviewedAt,
          note: record.review.analystSentiment?.note,
          model: {
            polarity: record.model!.polarity,
            intensity: record.model!.intensity,
            confidence: record.model!.confidence,
            rationale: record.model!.rationale,
          },
          analyst: {
            score100: record.review.analystSentiment!.score100,
            score5: record.review.analystSentiment!.score5,
            reviewState: record.review.state,
            correctionApplied: record.review.analystSentiment!.correctionApplied,
          },
        } satisfies ReviewedSentimentOutcomeSample;
      });
  }

  private summarizeReviewedResultsBy(
    results: ReturnType<typeof runReviewedSentimentValidationFromSamples>,
    keySelector: (result: ReturnType<typeof runReviewedSentimentValidationFromSamples>[number]) => string,
  ) {
    const buckets = results.reduce<Record<string, {
      total: number;
      averageDeltaScore100: number;
      averageDeltaScore5: number;
      exactScore5Matches: number;
      withinFivePointsScore100: number;
      correctedCount: number;
    }>>((aggregate, result) => {
      const key = keySelector(result);
      const bucket = aggregate[key] ?? {
        total: 0,
        averageDeltaScore100: 0,
        averageDeltaScore5: 0,
        exactScore5Matches: 0,
        withinFivePointsScore100: 0,
        correctedCount: 0,
      };
      bucket.total += 1;
      bucket.averageDeltaScore100 += result.deltaScore100;
      bucket.averageDeltaScore5 += result.deltaScore5;
      if (result.deltaScore5 === 0) {
        bucket.exactScore5Matches += 1;
      }
      if (result.deltaScore100 <= 5) {
        bucket.withinFivePointsScore100 += 1;
      }
      if (result.analystCorrectionApplied) {
        bucket.correctedCount += 1;
      }
      aggregate[key] = bucket;
      return aggregate;
    }, {});

    for (const bucket of Object.values(buckets)) {
      if (bucket.total > 0) {
        bucket.averageDeltaScore100 /= bucket.total;
        bucket.averageDeltaScore5 /= bucket.total;
      }
    }

    return buckets;
  }

  private formatReviewedBreakdown(
    breakdown: Record<string, {
      total: number;
      averageDeltaScore100: number;
      averageDeltaScore5: number;
      exactScore5Matches: number;
      withinFivePointsScore100: number;
      correctedCount: number;
    }>,
  ) {
    return Object.fromEntries(
      Object.entries(breakdown).map(([key, bucket]) => [
        key,
        {
          total: bucket.total,
          averageDeltaScore100: Number(bucket.averageDeltaScore100.toFixed(2)),
          averageDeltaScore5: Number(bucket.averageDeltaScore5.toFixed(2)),
          exactScore5Matches: bucket.exactScore5Matches,
          exactScore5MatchRate: bucket.total > 0
            ? Number((bucket.exactScore5Matches / bucket.total).toFixed(4))
            : 0,
          withinFivePointsScore100: bucket.withinFivePointsScore100,
          withinFivePointsRate: bucket.total > 0
            ? Number((bucket.withinFivePointsScore100 / bucket.total).toFixed(4))
            : 0,
          correctedCount: bucket.correctedCount,
        },
      ]),
    );
  }

  private deriveScopedThresholdOverrides(input: {
    currentThresholds: ReturnType<typeof modelValidationThresholdsSchema.parse>;
    baseThresholds: ReturnType<typeof modelValidationThresholdsSchema.parse>;
    liveBreakdown: Record<string, {
      runCount: number;
      failureRate: number;
      reviewRate: number;
      uncertainRate: number;
      schemaValidRate?: number;
      averageProcessingDurationMs?: number;
      p95ProcessingDurationMs?: number;
    }>;
    reviewedBreakdown: Record<string, {
      total: number;
      averageDeltaScore100: number;
      averageDeltaScore5: number;
      exactScore5Matches: number;
      withinFivePointsScore100: number;
    }>;
    minimumRunCount: number;
    minimumReviewedSampleSize: number;
    thresholdResolver: (
      thresholds: ReturnType<typeof modelValidationThresholdsSchema.parse>,
      scope: string,
    ) => ReturnType<typeof modelValidationThresholdsSchema.parse>;
  }) {
    const overrides: Record<string, ReturnType<typeof modelValidationThresholdOverrideSchema.parse>> = {};
    const scopes = new Set([
      ...Object.keys(input.liveBreakdown),
      ...Object.keys(input.reviewedBreakdown),
    ]);

    for (const scope of scopes) {
      const liveBucket = input.liveBreakdown[scope];
      const reviewedBucket = input.reviewedBreakdown[scope];
      if (!liveBucket || !reviewedBucket) {
        continue;
      }
      if (liveBucket.runCount < input.minimumRunCount) {
        continue;
      }
      if (reviewedBucket.total < input.minimumReviewedSampleSize) {
        continue;
      }

      const scopedThresholds = input.thresholdResolver(input.currentThresholds, scope);
      const scopedRecommendation = this.recommendScalarThresholds(scopedThresholds, liveBucket, reviewedBucket);
      const scopedOverride = this.compactThresholdOverride(input.baseThresholds, scopedRecommendation);
      if (Object.keys(scopedOverride).length > 0) {
        overrides[scope] = modelValidationThresholdOverrideSchema.parse(scopedOverride);
      }
    }

    return overrides;
  }

  private findUnderSampledScopes(input: {
    liveBreakdown: Record<string, { runCount: number }>;
    reviewedBreakdown: Record<string, { total: number }>;
    minimumRunCount: number;
    minimumReviewedSampleSize: number;
  }): string[] {
    const scopes = new Set([
      ...Object.keys(input.liveBreakdown),
      ...Object.keys(input.reviewedBreakdown),
    ]);

    return Array.from(scopes)
      .filter((scope) => {
        const liveRunCount = input.liveBreakdown[scope]?.runCount ?? 0;
        const reviewedCount = input.reviewedBreakdown[scope]?.total ?? 0;
        return liveRunCount > 0
          && (liveRunCount < input.minimumRunCount || reviewedCount < input.minimumReviewedSampleSize);
      })
      .sort();
  }

  private deriveRecommendedThresholds(
    currentThresholds: ReturnType<typeof modelValidationThresholdsSchema.parse>,
    liveMetrics: Awaited<ReturnType<ModelValidationService['computeLiveMetrics']>>,
    reviewedValidation: ReturnType<ModelValidationService['computeReviewedValidation']>,
    recommendationPolicy: {
      minimumRunCountPerEngagementType: number;
      minimumReviewedSampleSizePerEngagementType: number;
      minimumRunCountPerQueue: number;
      minimumReviewedSampleSizePerQueue: number;
      minimumRunCountPerTranscriptLengthBucket: number;
      minimumReviewedSampleSizePerTranscriptLengthBucket: number;
    },
  ) {
    const reviewedSummary = reviewedValidation?.summary ?? null;
    const baseThresholds = this.recommendScalarThresholds(
      currentThresholds,
      liveMetrics,
      reviewedSummary,
    );
    const byEngagementType = this.deriveScopedThresholdOverrides({
      currentThresholds,
      baseThresholds,
      liveBreakdown: liveMetrics.byEngagementType,
      reviewedBreakdown: reviewedSummary?.byEngagementType ?? {},
      minimumRunCount: recommendationPolicy.minimumRunCountPerEngagementType,
      minimumReviewedSampleSize: recommendationPolicy.minimumReviewedSampleSizePerEngagementType,
      thresholdResolver: (thresholds, scope) => this.thresholdsForScope(thresholds, 'ENGAGEMENT_TYPE', scope),
    });
    const byQueue = this.deriveScopedThresholdOverrides({
      currentThresholds,
      baseThresholds,
      liveBreakdown: liveMetrics.byQueue,
      reviewedBreakdown: reviewedValidation?.byQueue ?? {},
      minimumRunCount: recommendationPolicy.minimumRunCountPerQueue,
      minimumReviewedSampleSize: recommendationPolicy.minimumReviewedSampleSizePerQueue,
      thresholdResolver: (thresholds, scope) => this.thresholdsForScope(thresholds, 'QUEUE', scope),
    });
    const byTranscriptLengthBucket = this.deriveScopedThresholdOverrides({
      currentThresholds,
      baseThresholds,
      liveBreakdown: liveMetrics.byTranscriptLengthBucket,
      reviewedBreakdown: reviewedValidation?.byTranscriptLengthBucket ?? {},
      minimumRunCount: recommendationPolicy.minimumRunCountPerTranscriptLengthBucket,
      minimumReviewedSampleSize: recommendationPolicy.minimumReviewedSampleSizePerTranscriptLengthBucket,
      thresholdResolver: (thresholds, scope) => this.thresholdsForScope(thresholds, 'TRANSCRIPT_LENGTH_BUCKET', scope),
    });

    return modelValidationThresholdsSchema.parse({
      ...baseThresholds,
      byEngagementType,
      byQueue,
      byTranscriptLengthBucket,
    });
  }

  private recommendScalarThresholds(
    currentThresholds: ReturnType<typeof modelValidationThresholdsSchema.parse>,
    liveMetrics: {
      failureRate: number;
      reviewRate: number;
      uncertainRate: number;
      schemaValidRate?: number;
      averageProcessingDurationMs?: number;
      p95ProcessingDurationMs?: number;
    },
    reviewedSummary: {
      total: number;
      averageDeltaScore100: number;
      averageDeltaScore5: number;
      exactScore5Matches: number;
      withinFivePointsScore100: number;
    } | null,
  ) {
    const exactScore5MatchRate = reviewedSummary && reviewedSummary.total > 0
      ? reviewedSummary.exactScore5Matches / reviewedSummary.total
      : undefined;
    const withinFivePointsRate = reviewedSummary && reviewedSummary.total > 0
      ? reviewedSummary.withinFivePointsScore100 / reviewedSummary.total
      : undefined;

    return modelValidationThresholdsSchema.parse({
      minimumReviewedSampleSize: Math.max(
        currentThresholds.minimumReviewedSampleSize,
        Math.min(reviewedSummary?.total ?? 10, 25),
        10,
      ),
      maximumFailureRate: this.round(this.headroom(liveMetrics.failureRate, 0.02, 1.25, 0.5), 4),
      maximumReviewRate: this.round(this.headroom(liveMetrics.reviewRate, 0.03, 1.2, 0.75), 4),
      maximumUncertainRate: this.round(this.headroom(liveMetrics.uncertainRate, 0.02, 1.2, 0.5), 4),
      minimumSchemaValidRate: this.round(this.floorRate(liveMetrics.schemaValidRate, 0.01, 0.9), 4),
      maximumAverageDeltaScore100: this.round(this.headroom(reviewedSummary?.averageDeltaScore100 ?? currentThresholds.maximumAverageDeltaScore100, 1, 1.15, 100), 2),
      maximumAverageDeltaScore5: this.round(this.headroom(reviewedSummary?.averageDeltaScore5 ?? currentThresholds.maximumAverageDeltaScore5, 0.1, 1.15, 4), 2),
      minimumExactScore5MatchRate: this.round(this.floorRate(exactScore5MatchRate, 0.03, 0.5), 4),
      minimumWithinFivePointsRate: this.round(this.floorRate(withinFivePointsRate, 0.01, 0.8), 4),
      maximumAverageProcessingDurationMs: Math.max(
        currentThresholds.maximumAverageProcessingDurationMs,
        Math.ceil((liveMetrics.averageProcessingDurationMs ?? currentThresholds.maximumAverageProcessingDurationMs) * 1.15),
      ),
      maximumP95ProcessingDurationMs: Math.max(
        currentThresholds.maximumP95ProcessingDurationMs,
        Math.ceil((liveMetrics.p95ProcessingDurationMs ?? currentThresholds.maximumP95ProcessingDurationMs) * 1.15),
      ),
      byEngagementType: {},
    });
  }

  private recommendationNotes(
    liveMetrics: Awaited<ReturnType<ModelValidationService['computeLiveMetrics']>>,
    reviewedValidation: ReturnType<ModelValidationService['computeReviewedValidation']>,
    recommendationPolicy: {
      minimumRunCountPerEngagementType: number;
      minimumReviewedSampleSizePerEngagementType: number;
      minimumRunCountPerQueue: number;
      minimumReviewedSampleSizePerQueue: number;
      minimumRunCountPerTranscriptLengthBucket: number;
      minimumReviewedSampleSizePerTranscriptLengthBucket: number;
    },
  ): string[] {
    const reviewedSummary = reviewedValidation?.summary ?? null;
    const notes: string[] = [];
    if ((reviewedSummary?.total ?? 0) < 20) {
      notes.push('Reviewed sample size is still small; treat these recommendations as provisional.');
    }
    if (liveMetrics.runCount < 50) {
      notes.push('Live run volume in the current window is low; increase the window or wait for more traffic before locking thresholds.');
    }
    if (typeof liveMetrics.schemaValidRate !== 'number') {
      notes.push('Schema-valid rate is unavailable until terminal run events consistently record schema outcomes.');
    }

    const engagementTypes = new Set([
      ...Object.keys(liveMetrics.byEngagementType),
      ...Object.keys(reviewedSummary?.byEngagementType ?? {}),
    ]);
    const underSampled = Array.from(engagementTypes)
      .filter((engagementType) => {
        const liveRunCount = liveMetrics.byEngagementType[engagementType]?.runCount ?? 0;
        const reviewedCount = reviewedSummary?.byEngagementType[engagementType]?.total ?? 0;
        return liveRunCount > 0
          && reviewedCount > 0
          && (
            liveRunCount < recommendationPolicy.minimumRunCountPerEngagementType
            || reviewedCount < recommendationPolicy.minimumReviewedSampleSizePerEngagementType
          );
      })
      .sort();
    if (underSampled.length > 0) {
      notes.push(
        `Engagement-specific thresholds remain provisional for ${underSampled.join(', ')} because they do not yet meet the per-engagement sample minimums.`,
      );
    }

    const underSampledQueues = this.findUnderSampledScopes({
      liveBreakdown: liveMetrics.byQueue,
      reviewedBreakdown: reviewedValidation?.byQueue ?? {},
      minimumRunCount: recommendationPolicy.minimumRunCountPerQueue,
      minimumReviewedSampleSize: recommendationPolicy.minimumReviewedSampleSizePerQueue,
    });
    if (underSampledQueues.length > 0) {
      notes.push(
        `Queue-specific thresholds remain provisional for ${underSampledQueues.join(', ')} because they do not yet meet the per-queue sample minimums.`,
      );
    }

    const underSampledLengthBuckets = this.findUnderSampledScopes({
      liveBreakdown: liveMetrics.byTranscriptLengthBucket,
      reviewedBreakdown: reviewedValidation?.byTranscriptLengthBucket ?? {},
      minimumRunCount: recommendationPolicy.minimumRunCountPerTranscriptLengthBucket,
      minimumReviewedSampleSize: recommendationPolicy.minimumReviewedSampleSizePerTranscriptLengthBucket,
    });
    if (underSampledLengthBuckets.length > 0) {
      notes.push(
        `Transcript-length thresholds remain provisional for ${underSampledLengthBuckets.join(', ')} because they do not yet meet the per-length sample minimums.`,
      );
    }
    return notes;
  }

  private thresholdsForScope(
    thresholds: ReturnType<typeof modelValidationThresholdsSchema.parse>,
    scopeType: 'ENGAGEMENT_TYPE' | 'QUEUE' | 'TRANSCRIPT_LENGTH_BUCKET',
    scope: string,
  ) {
    const override = scopeType === 'ENGAGEMENT_TYPE'
      ? thresholds.byEngagementType[scope] ?? {}
      : scopeType === 'QUEUE'
        ? thresholds.byQueue[scope] ?? {}
        : thresholds.byTranscriptLengthBucket[scope] ?? {};
    return modelValidationThresholdsSchema.parse({
      ...thresholds,
      ...override,
      byEngagementType: thresholds.byEngagementType,
      byQueue: thresholds.byQueue,
      byTranscriptLengthBucket: thresholds.byTranscriptLengthBucket,
    });
  }

  private thresholdOverrideScopesForType(
    thresholds: ReturnType<typeof modelValidationThresholdsSchema.parse>,
    scopeType: 'ENGAGEMENT_TYPE' | 'QUEUE' | 'TRANSCRIPT_LENGTH_BUCKET',
  ): string[] {
    if (scopeType === 'ENGAGEMENT_TYPE') {
      return Object.keys(thresholds.byEngagementType);
    }
    if (scopeType === 'QUEUE') {
      return Object.keys(thresholds.byQueue);
    }
    return Object.keys(thresholds.byTranscriptLengthBucket);
  }

  private scopeAlertPrefix(
    scopeType: 'ENGAGEMENT_TYPE' | 'QUEUE' | 'TRANSCRIPT_LENGTH_BUCKET',
    scope: string,
  ): string {
    if (scopeType === 'ENGAGEMENT_TYPE') {
      return `[${scope}]`;
    }
    if (scopeType === 'QUEUE') {
      return `[QUEUE:${scope}]`;
    }
    return `[LENGTH:${scope}]`;
  }

  private scopeAlertMetadata(
    scopeType: 'ENGAGEMENT_TYPE' | 'QUEUE' | 'TRANSCRIPT_LENGTH_BUCKET',
    scope: string,
  ): Record<string, unknown> {
    if (scopeType === 'ENGAGEMENT_TYPE') {
      return { engagementType: scope, scopeType: 'ENGAGEMENT_TYPE', scopeValue: scope };
    }
    if (scopeType === 'QUEUE') {
      return { queue: scope, scopeType: 'QUEUE', scopeValue: scope };
    }
    return { transcriptLengthBucket: scope, scopeType: 'TRANSCRIPT_LENGTH_BUCKET', scopeValue: scope };
  }

  private compactThresholdOverride(
    baseThresholds: ReturnType<typeof modelValidationThresholdsSchema.parse>,
    scopedThresholds: ReturnType<typeof modelValidationThresholdsSchema.parse>,
  ) {
    const keys: Array<keyof ReturnType<typeof modelValidationThresholdsSchema.parse>> = [
      'minimumReviewedSampleSize',
      'maximumFailureRate',
      'maximumReviewRate',
      'maximumUncertainRate',
      'minimumSchemaValidRate',
      'maximumAverageDeltaScore100',
      'maximumAverageDeltaScore5',
      'minimumExactScore5MatchRate',
      'minimumWithinFivePointsRate',
      'maximumAverageProcessingDurationMs',
      'maximumP95ProcessingDurationMs',
    ];
    const override: Record<string, number> = {};

    for (const key of keys) {
      if (scopedThresholds[key] !== baseThresholds[key]) {
        override[key] = scopedThresholds[key] as number;
      }
    }

    return override;
  }

  private computeLiveBreakdown(
    groups: Map<string, AnalysisJobRecord[]>,
    runEventsByJob: Map<string, { events: Array<{ type: string; metadata?: Record<string, unknown> }> }>,
  ) {
    return Object.fromEntries(
      Array.from(groups.entries()).map(([bucketName, scopedJobs]) => {
        const scopedCompleted = scopedJobs.filter((job) => job.status === 'COMPLETED');
        const scopedFailed = scopedJobs.filter((job) => job.status === 'FAILED');
        const scopedReviewCount = scopedCompleted.filter((job) => job.result?.review.state === 'NEEDS_REVIEW').length;
        const scopedUncertainCount = scopedCompleted.filter((job) => job.result?.review.state === 'UNCERTAIN').length;
        const scopedTerminal = scopedJobs.filter((job) => job.status === 'COMPLETED' || job.status === 'FAILED');
        const scopedDurations: number[] = [];
        let scopedSchemaValidRuns = 0;
        let scopedSchemaInvalidRuns = 0;

        for (const job of scopedTerminal) {
          const snapshot = runEventsByJob.get(job.jobId);
          const terminalEvent = this.terminalRunEvent(snapshot?.events ?? []);
          const durationMs = this.processingDurationMs(job, terminalEvent?.metadata ?? {});
          if (typeof durationMs === 'number') {
            scopedDurations.push(durationMs);
          }

          if (job.status === 'COMPLETED') {
            if (terminalEvent?.metadata?.schemaValidationPassed !== false) {
              scopedSchemaValidRuns += 1;
            }
            continue;
          }

          if (terminalEvent?.metadata?.failureKind === 'SCHEMA_INVALID') {
            scopedSchemaInvalidRuns += 1;
          }
        }

        const scopedSchemaValidatedRuns = scopedSchemaValidRuns + scopedSchemaInvalidRuns;
        return [
          bucketName,
          {
            runCount: scopedJobs.length,
            completedRuns: scopedCompleted.length,
            failedRuns: scopedFailed.length,
            reviewCount: scopedReviewCount,
            uncertainCount: scopedUncertainCount,
            schemaValidatedRuns: scopedSchemaValidatedRuns,
            schemaValidRuns: scopedSchemaValidRuns,
            schemaInvalidRuns: scopedSchemaInvalidRuns,
            failureRate: scopedJobs.length > 0 ? Number((scopedFailed.length / scopedJobs.length).toFixed(4)) : 0,
            reviewRate: scopedCompleted.length > 0 ? Number((scopedReviewCount / scopedCompleted.length).toFixed(4)) : 0,
            uncertainRate: scopedCompleted.length > 0 ? Number((scopedUncertainCount / scopedCompleted.length).toFixed(4)) : 0,
            schemaValidRate: scopedSchemaValidatedRuns > 0
              ? this.round(scopedSchemaValidRuns / scopedSchemaValidatedRuns, 4)
              : undefined,
            averageProcessingDurationMs: scopedDurations.length > 0
              ? this.round(scopedDurations.reduce((sum, value) => sum + value, 0) / scopedDurations.length, 2)
              : undefined,
            p95ProcessingDurationMs: scopedDurations.length > 0
              ? this.round(this.percentile(scopedDurations, 0.95), 2)
              : undefined,
          },
        ] as const;
      }),
    );
  }

  private headroom(value: number, absoluteMargin: number, multiplier: number, maxValue: number): number {
    return Math.min(maxValue, Math.max(absoluteMargin, value + absoluteMargin, value * multiplier));
  }

  private floorRate(value: number | undefined, margin: number, minimum: number): number {
    if (typeof value !== 'number') {
      return minimum;
    }
    return Math.max(minimum, value - margin);
  }

  private terminalRunEvent(events: Array<{ type: string; metadata?: Record<string, unknown> }>) {
    return events
      .filter((event) => event.type === 'RUN_COMPLETED' || event.type === 'RUN_FAILED')
      .slice()
      .reverse()[0];
  }

  private processingDurationMs(
    job: AnalysisJobRecord,
    metadata: Record<string, unknown>,
  ): number | undefined {
    if (typeof metadata.durationMs === 'number' && Number.isFinite(metadata.durationMs)) {
      return metadata.durationMs;
    }

    const startedAt = Date.parse(job.createdAt);
    const endedAt = Date.parse(job.updatedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
      return undefined;
    }

    return endedAt - startedAt;
  }

  private percentile(values: number[], quantile: number): number {
    const sorted = values.slice().sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
    return sorted[index];
  }

  private round(value: number, places: number): number {
    return Number(value.toFixed(places));
  }

  private toReviewedRunExportRecord(
    job: AnalysisJobRecord,
    request: ReturnType<typeof reviewedRunExportRequestSchema.parse>,
  ): ReviewedRunExportRecord | null {
    if (job.status !== 'COMPLETED' || !job.result) {
      return null;
    }
    if (request.useCase && job.useCase !== request.useCase) {
      return null;
    }
    if (request.since && job.createdAt < request.since) {
      return null;
    }
    if (request.until && job.createdAt > request.until) {
      return null;
    }

    const packVersion = this.packVersionForJob(job);
    if (request.packVersion && packVersion !== request.packVersion) {
      return null;
    }
    if (request.requireReviewResolution && !job.result.review.resolution) {
      return null;
    }
    if (request.requireAnalystSentiment && !job.result.review.analystSentiment) {
      return null;
    }

    const transcript = request.includeTranscript && job.request
      ? maskAnalysisRequest(job.request).request.transcript
      : undefined;
    const transcriptStats = job.request?.transcript
      ? deriveTranscriptStats(job.request.transcript)
      : undefined;

    return reviewedRunExportRecordSchema.parse({
      runId: job.jobId,
      tenantId: job.tenantId,
      useCase: job.useCase,
      engagementType: this.stringMetadata(job.request?.transcript.metadata, 'engagementType'),
      queue: this.stringMetadata(job.request?.transcript.metadata, 'queue'),
      transcriptTurnCount: transcriptStats?.transcriptTurnCount,
      transcriptCharacterCount: transcriptStats?.transcriptCharacterCount,
      transcriptLengthBucket: transcriptStats?.transcriptLengthBucket,
      sourceDataset: this.stringMetadata(job.request?.transcript.metadata, 'sourceDataset'),
      datasetTrack: this.datasetTrackMetadata(job.request?.transcript.metadata),
      conversationId: job.conversationId,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      packVersion,
      promptVersion: job.result.trace.promptVersion,
      engine: job.result.trace.engine,
      transcript,
      model: job.result.overallEndUserSentiment,
      review: {
        state: job.result.review.state,
        decision: job.result.review.resolution?.decision,
        reviewedAt: job.result.review.resolution?.decidedAt,
        reviewedById: job.result.review.resolution?.actorId,
        reviewedByType: job.result.review.resolution?.actorType,
        analystSentiment: job.result.review.analystSentiment,
        reasons: job.result.review.reasons,
      },
      piiRedactionSummary: job.piiRedactionSummary,
    });
  }

  private async loadReviewedExportRecords(tenantId: string, useCase: string): Promise<ReviewedRunExportRecord[]> {
    const datasetFiles = await this.resolveReviewedDatasetFiles(tenantId, useCase);
    if (datasetFiles.length === 0) {
      return [];
    }

    const recordsByRunId = new Map<string, ReviewedRunExportRecord>();

    for (const datasetFile of datasetFiles) {
      const records = await this.loadReviewedExportRecordsFromFile(datasetFile.path);
      for (const record of records) {
        const existing = recordsByRunId.get(record.runId);
        if (!existing || this.reviewedRecordTimestamp(record) >= this.reviewedRecordTimestamp(existing)) {
          recordsByRunId.set(record.runId, record);
        }
      }
    }

    return Array.from(recordsByRunId.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private async loadReviewedExportRecordsFromFile(path: string): Promise<ReviewedRunExportRecord[]> {
    const records: ReviewedRunExportRecord[] = [];
    for await (const record of this.iterReviewedExportRecordsFromFile(path)) {
      records.push(record);
    }
    return records;
  }

  private async *iterReviewedExportRecordsFromFile(path: string): AsyncGenerator<ReviewedRunExportRecord> {
    const format = this.reviewedDatasetFormat(path);
    if (format === 'JSONL') {
      const stream = path.endsWith('.gz')
        ? createReadStream(path).pipe(createGunzip())
        : createReadStream(path);
      const reader = createInterface({
        input: stream,
        crlfDelay: Infinity,
      });
      for await (const line of reader) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        yield reviewedRunExportRecordSchema.parse(JSON.parse(trimmed));
      }
      return;
    }

    const raw = await this.readReviewedDatasetText(path);
    const trimmed = raw.trim();
    if (!trimmed) {
      return;
    }
    const parsed = JSON.parse(trimmed) as unknown[];
    for (const record of parsed) {
      yield reviewedRunExportRecordSchema.parse(record);
    }
  }

  private async readReviewedDatasetText(path: string): Promise<string> {
    const raw = await readFile(path);
    if (path.endsWith('.gz')) {
      return gunzipSync(raw).toString('utf8');
    }
    return raw.toString('utf8');
  }

  private async resolveReviewedDatasetScopes(filters: {
    tenantId?: string;
    useCase?: string;
  }): Promise<ReviewedDatasetInventoryScope[]> {
    if (!this.reviewedDataDir) {
      return [];
    }

    const baseDir = resolve(this.cwd, this.reviewedDataDir);
    if (!existsSync(baseDir)) {
      return [];
    }

    const scopes = new Set<string>();
    const baseEntries = await readdir(baseDir, { withFileTypes: true });
    for (const entry of baseEntries) {
      if (!entry.isDirectory() || entry.name === 'snapshots') {
        continue;
      }
      const tenantId = entry.name;
      if (filters.tenantId && tenantId !== filters.tenantId) {
        continue;
      }
      const tenantDir = join(baseDir, tenantId);
      const tenantEntries = await readdir(tenantDir, { withFileTypes: true });
      for (const tenantEntry of tenantEntries) {
        if (tenantEntry.isDirectory()) {
          const useCase = tenantEntry.name;
          if (filters.useCase && useCase !== filters.useCase) {
            continue;
          }
          scopes.add(`${tenantId}::${useCase}`);
          continue;
        }
        if (!tenantEntry.isFile()) {
          continue;
        }
        const useCase = this.reviewedDatasetUseCaseFromFilename(tenantEntry.name);
        if (!useCase) {
          continue;
        }
        if (filters.useCase && useCase !== filters.useCase) {
          continue;
        }
        scopes.add(`${tenantId}::${useCase}`);
      }
    }

    const snapshotRoot = join(baseDir, 'snapshots');
    if (existsSync(snapshotRoot)) {
      const snapshotTenants = await readdir(snapshotRoot, { withFileTypes: true });
      for (const tenantEntry of snapshotTenants) {
        if (!tenantEntry.isDirectory()) {
          continue;
        }
        const tenantId = tenantEntry.name;
        if (filters.tenantId && tenantId !== filters.tenantId) {
          continue;
        }
        const tenantDir = join(snapshotRoot, tenantId);
        const useCaseEntries = await readdir(tenantDir, { withFileTypes: true });
        for (const useCaseEntry of useCaseEntries) {
          if (!useCaseEntry.isDirectory()) {
            continue;
          }
          const useCase = useCaseEntry.name;
          if (filters.useCase && useCase !== filters.useCase) {
            continue;
          }
          scopes.add(`${tenantId}::${useCase}`);
        }
      }
    }

    if (filters.tenantId) {
      const legacySnapshotDir = join(baseDir, filters.tenantId);
      if (existsSync(legacySnapshotDir)) {
        const useCaseEntries = await readdir(legacySnapshotDir, { withFileTypes: true });
        for (const useCaseEntry of useCaseEntries) {
          if (!useCaseEntry.isDirectory()) {
            continue;
          }
          const useCase = useCaseEntry.name;
          if (filters.useCase && useCase !== filters.useCase) {
            continue;
          }
          scopes.add(`${filters.tenantId}::${useCase}`);
        }
      }
    }

    const summaries = await Promise.all(
      Array.from(scopes)
        .sort()
        .map(async (scopeKey) => {
          const [tenantId, useCase] = scopeKey.split('::');
          return this.summarizeReviewedDatasetScope(baseDir, tenantId, useCase);
        }),
    );
    return summaries.filter((scope): scope is ReviewedDatasetInventoryScope => scope !== null);
  }

  private async summarizeReviewedDatasetScope(
    baseDir: string,
    tenantId: string,
    useCase: string,
  ): Promise<ReviewedDatasetInventoryScope | null> {
    const datasetFiles = await this.resolveReviewedDatasetFiles(tenantId, useCase);
    if (datasetFiles.length === 0) {
      return null;
    }

    const files: ReviewedDatasetInventoryScope['files'] = [];

    for (const descriptor of datasetFiles) {
      const fileSummary = await this.summarizeReviewedDatasetFile(descriptor.path);
      files.push({
        path: descriptor.path,
        format: fileSummary.format,
        compression: fileSummary.compression,
        snapshot: descriptor.snapshot,
        recordCount: fileSummary.recordCount,
        analystSentimentCount: fileSummary.analystSentimentCount,
        latestUpdatedAt: fileSummary.latestUpdatedAt,
      });
    }

    const dedupedRecords = await this.loadReviewedExportRecords(tenantId, useCase);
    const manifestPath = join(baseDir, tenantId, `${useCase}.manifest.json`);
    const manifest = existsSync(manifestPath)
      ? reviewedRunExportManifestSchema.safeParse(JSON.parse(await readFile(manifestPath, 'utf8'))).data
      : undefined;
    const byPackVersion: Record<string, number> = {};
    const byEngagementType: Record<string, number> = {};
    const byQueue: Record<string, number> = {};
    const byTranscriptLengthBucket: Record<string, number> = {};
    let analystSentimentCount = 0;
    let latestUpdatedAt: string | undefined;

    for (const record of dedupedRecords) {
      if (record.review.analystSentiment) {
        analystSentimentCount += 1;
      }
      if (!latestUpdatedAt || record.updatedAt > latestUpdatedAt) {
        latestUpdatedAt = record.updatedAt;
      }
      if (record.packVersion) {
        byPackVersion[record.packVersion] = (byPackVersion[record.packVersion] ?? 0) + 1;
      }
      if (record.engagementType) {
        byEngagementType[record.engagementType] = (byEngagementType[record.engagementType] ?? 0) + 1;
      }
      if (record.queue) {
        byQueue[record.queue] = (byQueue[record.queue] ?? 0) + 1;
      }
      if (record.transcriptLengthBucket) {
        byTranscriptLengthBucket[record.transcriptLengthBucket] = (byTranscriptLengthBucket[record.transcriptLengthBucket] ?? 0) + 1;
      }
    }

    return {
      tenantId,
      useCase,
      latestPath: datasetFiles.find((descriptor) => !descriptor.snapshot)?.path,
      snapshotDirectory: existsSync(join(baseDir, 'snapshots', tenantId, useCase))
        ? join(baseDir, 'snapshots', tenantId, useCase)
        : existsSync(join(baseDir, tenantId, useCase))
          ? join(baseDir, tenantId, useCase)
        : undefined,
      latestUpdatedAt,
      fileCount: datasetFiles.length,
      snapshotCount: datasetFiles.filter((descriptor) => descriptor.snapshot).length,
      recordCount: dedupedRecords.length,
      analystSentimentCount,
      byPackVersion,
      byEngagementType,
      byQueue,
      byTranscriptLengthBucket,
      includeTranscript: manifest?.includeTranscript,
      requireAnalystSentiment: manifest?.requireAnalystSentiment,
      classification: manifest?.classification,
      retentionDays: manifest?.retentionDays,
      maximumSnapshots: manifest?.maximumSnapshots,
      coverageRequirements: manifest?.coverageRequirements,
      coverageFailures: manifest?.coverageFailures ?? [],
      files,
    };
  }

  private async summarizeReviewedDatasetFile(path: string): Promise<{
    format: 'JSON' | 'JSONL';
    compression: 'NONE' | 'GZIP';
    recordCount: number;
    analystSentimentCount: number;
    latestUpdatedAt?: string;
    byPackVersion: Record<string, number>;
    byEngagementType: Record<string, number>;
    byQueue: Record<string, number>;
    byTranscriptLengthBucket: Record<string, number>;
  }> {
    const summary = {
      format: this.reviewedDatasetFormat(path),
      compression: path.endsWith('.gz') ? 'GZIP' as const : 'NONE' as const,
      recordCount: 0,
      analystSentimentCount: 0,
      latestUpdatedAt: undefined as string | undefined,
      byPackVersion: {} as Record<string, number>,
      byEngagementType: {} as Record<string, number>,
      byQueue: {} as Record<string, number>,
      byTranscriptLengthBucket: {} as Record<string, number>,
    };

    for await (const record of this.iterReviewedExportRecordsFromFile(path)) {
      summary.recordCount += 1;
      if (record.review.analystSentiment) {
        summary.analystSentimentCount += 1;
      }
      if (!summary.latestUpdatedAt || record.updatedAt > summary.latestUpdatedAt) {
        summary.latestUpdatedAt = record.updatedAt;
      }
      if (record.packVersion) {
        summary.byPackVersion[record.packVersion] = (summary.byPackVersion[record.packVersion] ?? 0) + 1;
      }
      if (record.engagementType) {
        summary.byEngagementType[record.engagementType] = (summary.byEngagementType[record.engagementType] ?? 0) + 1;
      }
      if (record.queue) {
        summary.byQueue[record.queue] = (summary.byQueue[record.queue] ?? 0) + 1;
      }
      if (record.transcriptLengthBucket) {
        summary.byTranscriptLengthBucket[record.transcriptLengthBucket] = (summary.byTranscriptLengthBucket[record.transcriptLengthBucket] ?? 0) + 1;
      }
    }

    return summary;
  }

  private async resolveReviewedDatasetFiles(tenantId: string, useCase: string): Promise<ReviewedDatasetFileDescriptor[]> {
    if (!this.reviewedDataDir) {
      return [];
    }

    const baseDir = resolve(this.cwd, this.reviewedDataDir);
    const datasetFiles: ReviewedDatasetFileDescriptor[] = [];

    for (const suffix of ['.jsonl', '.jsonl.gz', '.ndjson', '.ndjson.gz', '.json', '.json.gz']) {
      const path = join(baseDir, tenantId, `${useCase}${suffix}`);
      if (existsSync(path)) {
        datasetFiles.push({ path, snapshot: false });
      }
    }

    for (const snapshotDir of [
      join(baseDir, 'snapshots', tenantId, useCase),
      join(baseDir, tenantId, useCase),
    ]) {
      if (existsSync(snapshotDir)) {
        const entries = await readdir(snapshotDir);
        for (const entry of entries.sort()) {
          if (!this.isReviewedDatasetFile(entry)) {
            continue;
          }
          datasetFiles.push({
            path: join(snapshotDir, entry),
            snapshot: true,
          });
        }
      }
    }

    return datasetFiles;
  }

  private isReviewedDatasetFile(path: string): boolean {
    return this.reviewedDatasetUseCaseFromFilename(path) !== null;
  }

  private reviewedDatasetUseCaseFromFilename(path: string): string | null {
    if (path.endsWith('.manifest.json')) {
      return null;
    }
    const suffix = ['.jsonl.gz', '.ndjson.gz', '.json.gz', '.jsonl', '.ndjson', '.json']
      .find((candidate) => path.endsWith(candidate));
    if (!suffix) {
      return null;
    }
    return path.slice(0, -suffix.length);
  }

  private reviewedDatasetFormat(path: string): 'JSON' | 'JSONL' {
    return path.endsWith('.json') || path.endsWith('.json.gz') ? 'JSON' : 'JSONL';
  }

  private mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
    for (const [key, count] of Object.entries(source)) {
      target[key] = (target[key] ?? 0) + count;
    }
  }

  private reviewedRecordTimestamp(record: ReviewedRunExportRecord): number {
    const candidates = [
      record.review.analystSentiment?.reviewedAt,
      record.review.reviewedAt,
      record.updatedAt,
      record.createdAt,
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return 0;
  }

  private async canaryAlertForPack(
    tenantId: string,
    useCase: string,
    packVersion: string | undefined,
    createdAt: string,
    reportId: string,
  ): Promise<ModelValidationAlert | null> {
    if (!packVersion) {
      return null;
    }

    const state = await this.tenantPacks.describe(tenantId, useCase);
    const release = state.releases.find((item) => item.packVersion === packVersion);
    if (!release) {
      return null;
    }

    const latestEvaluation = release.canary?.evaluations?.[release.canary.evaluations.length - 1];
    const rejected = release.status === 'REJECTED' || latestEvaluation?.decision === 'FAIL';
    if (!rejected) {
      return null;
    }

    return {
      alertId: randomUUID(),
      reportId,
      tenantId,
      useCase,
      packVersion,
      createdAt,
      kind: 'CANARY_REJECTED',
      severity: 'CRITICAL',
      message: `Pack ${packVersion} has a rejected or failed canary result.`,
      metadata: {
        status: release.status,
        latestCanaryDecision: latestEvaluation?.decision,
      },
    };
  }

  private async notifyReport(report: ModelValidationReport): Promise<void> {
    if (!this.notifier || report.alerts.length === 0) {
      return;
    }

    try {
      await this.notifier.notify(report);
    } catch (error) {
      this.observability.incrementCounter('conversation_intelligence.model_validation.alert_delivery.failures', 1, {
        tenant_id: report.tenantId,
        use_case: report.useCase,
      });
    }
  }

  private packVersionForJob(job: AnalysisJobRecord): string | undefined {
    return job.result?.trace.packVersion ?? job.request?.tenantPack.packVersion;
  }

  private windowStart(windowHours: number, now: string): string {
    return new Date(Date.parse(now) - (windowHours * 60 * 60 * 1000)).toISOString();
  }

  private minutesSince(timestamp: string): number {
    const millis = Date.parse(timestamp);
    if (!Number.isFinite(millis)) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(0, Math.floor((this.clock().getTime() - millis) / 60000));
  }

  private stringMetadata(
    metadata: Record<string, unknown> | undefined,
    key: string,
  ): string | undefined {
    const value = metadata?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private datasetTrackMetadata(
    metadata: Record<string, unknown> | undefined,
  ): 'OPEN_CORE' | 'RESEARCH_ONLY' | 'SYNTHETIC' | undefined {
    const value = metadata?.datasetTrack;
    return value === 'OPEN_CORE' || value === 'RESEARCH_ONLY' || value === 'SYNTHETIC'
      ? value
      : undefined;
  }

  private groupJobsByEngagementType(jobs: AnalysisJobRecord[]): Map<string, AnalysisJobRecord[]> {
    return jobs.reduce((groups, job) => {
      const engagementType = this.engagementTypeForJob(job);
      const bucket = groups.get(engagementType) ?? [];
      bucket.push(job);
      groups.set(engagementType, bucket);
      return groups;
    }, new Map<string, AnalysisJobRecord[]>());
  }

  private groupJobsByQueue(jobs: AnalysisJobRecord[]): Map<string, AnalysisJobRecord[]> {
    return jobs.reduce((groups, job) => {
      const queue = this.queueForJob(job);
      const bucket = groups.get(queue) ?? [];
      bucket.push(job);
      groups.set(queue, bucket);
      return groups;
    }, new Map<string, AnalysisJobRecord[]>());
  }

  private groupJobsByTranscriptLengthBucket(jobs: AnalysisJobRecord[]): Map<string, AnalysisJobRecord[]> {
    return jobs.reduce((groups, job) => {
      const bucketName = this.transcriptLengthBucketForJob(job);
      const bucket = groups.get(bucketName) ?? [];
      bucket.push(job);
      groups.set(bucketName, bucket);
      return groups;
    }, new Map<string, AnalysisJobRecord[]>());
  }

  private engagementTypeForJob(job: AnalysisJobRecord): string {
    const engagementType = this.stringMetadata(job.request?.transcript.metadata, 'engagementType');
    return engagementType ?? 'UNSPECIFIED';
  }

  private queueForJob(job: AnalysisJobRecord): string {
    const queue = this.stringMetadata(job.request?.transcript.metadata, 'queue');
    return queue ?? 'UNSPECIFIED';
  }

  private transcriptLengthBucketForJob(job: AnalysisJobRecord): string {
    const bucket = this.validTranscriptLengthBucket(this.stringMetadata(job.request?.transcript.metadata, 'transcriptLengthBucket'));
    if (bucket) {
      return bucket;
    }
    if (job.request?.transcript) {
      return deriveTranscriptStats(job.request.transcript).transcriptLengthBucket;
    }
    return 'UNSPECIFIED';
  }

  private validTranscriptLengthBucket(
    value: string | undefined,
  ): 'SHORT' | 'MEDIUM' | 'LONG' | 'VERY_LONG' | undefined {
    return value === 'SHORT' || value === 'MEDIUM' || value === 'LONG' || value === 'VERY_LONG'
      ? value
      : undefined;
  }
}
