import { z } from 'zod';
import { reviewStateSchema } from './roles';
import { sentimentPolaritySchema } from './roles';
import { transcriptInputSchema } from './transcript';

const exportReviewDecisionActionSchema = z.enum(['VERIFY', 'MARK_UNCERTAIN', 'KEEP_NEEDS_REVIEW']);

const exportedOverallSentimentSchema = z.object({
  polarity: sentimentPolaritySchema,
  intensity: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  score: z.object({
    method: z.enum(['derived_v1', 'derived_v1_calibrated']),
    score100: z.number().int().min(0).max(100),
    score5: z.number().int().min(1).max(5),
    calibration: z.object({
      score100Offset: z.number().int().min(-20).max(20),
      engagementType: z.enum(['CALL', 'EMAIL', 'TICKET', 'CHAT']).optional(),
    }).optional(),
  }).optional(),
});

export const analystSentimentLabelInputSchema = z.object({
  score100: z.number().int().min(0).max(100),
  correctionApplied: z.boolean().default(true),
  note: z.string().trim().min(1).max(2000).optional(),
});

export type AnalystSentimentLabelInput = z.input<typeof analystSentimentLabelInputSchema>;

export const analystSentimentLabelSchema = analystSentimentLabelInputSchema.extend({
  score5: z.number().int().min(1).max(5),
  reviewedAt: z.string().min(1),
  reviewedById: z.string().min(1),
  reviewedByType: z.enum(['ANONYMOUS', 'USER', 'SERVICE', 'API_KEY', 'SYSTEM']),
});

export type AnalystSentimentLabel = z.infer<typeof analystSentimentLabelSchema>;

export const transcriptLengthBucketSchema = z.enum(['SHORT', 'MEDIUM', 'LONG', 'VERY_LONG']);
export type TranscriptLengthBucket = z.infer<typeof transcriptLengthBucketSchema>;

export const reviewedRunExportRecordSchema = z.object({
  runId: z.string().min(1),
  tenantId: z.string().min(1),
  useCase: z.string().min(1),
  engagementType: z.enum(['CALL', 'EMAIL', 'TICKET', 'CHAT']).optional(),
  queue: z.string().min(1).optional(),
  transcriptTurnCount: z.number().int().min(0).optional(),
  transcriptCharacterCount: z.number().int().min(0).optional(),
  transcriptLengthBucket: transcriptLengthBucketSchema.optional(),
  sourceDataset: z.string().min(1).optional(),
  datasetTrack: z.enum(['OPEN_CORE', 'RESEARCH_ONLY', 'SYNTHETIC']).optional(),
  conversationId: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  packVersion: z.string().min(1).optional(),
  promptVersion: z.string().min(1).optional(),
  engine: z.enum(['rlm', 'rules']).optional(),
  transcript: transcriptInputSchema.optional(),
  model: exportedOverallSentimentSchema.nullable(),
  review: z.object({
    state: reviewStateSchema,
    decision: exportReviewDecisionActionSchema.optional(),
    reviewedAt: z.string().min(1).optional(),
    reviewedById: z.string().min(1).optional(),
    reviewedByType: z.enum(['ANONYMOUS', 'USER', 'SERVICE', 'API_KEY', 'SYSTEM']).optional(),
    analystSentiment: analystSentimentLabelSchema.optional(),
    reasons: z.array(z.string()).default([]),
  }),
  piiRedactionSummary: z.object({
    applied: z.boolean(),
    redactionCount: z.number().int().min(0),
    ruleHits: z.record(z.string(), z.number().int().min(0)).default({}),
  }).optional(),
});

export type ReviewedRunExportRecord = z.infer<typeof reviewedRunExportRecordSchema>;

export const reviewedRunExportRequestSchema = z.object({
  tenantId: z.string().min(1).optional(),
  useCase: z.string().min(1).optional(),
  packVersion: z.string().min(1).optional(),
  since: z.string().min(1).optional(),
  until: z.string().min(1).optional(),
  includeTranscript: z.boolean().default(true),
  requireReviewResolution: z.boolean().default(true),
  requireAnalystSentiment: z.boolean().default(false),
});

export type ReviewedRunExportRequest = z.input<typeof reviewedRunExportRequestSchema>;

export const reviewedRunExportResponseSchema = z.object({
  generatedAt: z.string().min(1),
  exportedCount: z.number().int().min(0),
  skippedCount: z.number().int().min(0),
});

export type ReviewedRunExportResponse = z.infer<typeof reviewedRunExportResponseSchema>;

export const reviewedRunExportRefreshRequestSchema = z.object({
  tenantId: z.string().min(1).optional(),
  useCase: z.string().min(1).optional(),
  force: z.boolean().default(false),
  includeTranscript: z.boolean().optional(),
  requireAnalystSentiment: z.boolean().optional(),
});

export type ReviewedRunExportRefreshRequest = z.input<typeof reviewedRunExportRefreshRequestSchema>;

export const reviewedRunExportRefreshResultSchema = z.object({
  tenantId: z.string().min(1),
  useCase: z.string().min(1),
  generatedAt: z.string().min(1),
  exportedCount: z.number().int().min(0),
  skippedCount: z.number().int().min(0),
  analystSentimentCount: z.number().int().min(0).default(0),
  latestPath: z.string().min(1),
  snapshotPath: z.string().min(1),
  manifestPath: z.string().min(1).optional(),
});

export type ReviewedRunExportRefreshResult = z.infer<typeof reviewedRunExportRefreshResultSchema>;

export const reviewedDatasetCoverageRequirementsSchema = z.object({
  minimumRecordCount: z.number().int().min(0).default(0),
  minimumAnalystSentimentCount: z.number().int().min(0).default(0),
  maximumDatasetAgeHours: z.number().int().min(1).optional(),
  byEngagementType: z.record(z.string(), z.number().int().min(0)).default({}),
  byQueue: z.record(z.string(), z.number().int().min(0)).default({}),
  byTranscriptLengthBucket: z.record(z.string(), z.number().int().min(0)).default({}),
});

export type ReviewedDatasetCoverageRequirements = z.infer<typeof reviewedDatasetCoverageRequirementsSchema>;

export const reviewedRunExportManifestSchema = z.object({
  tenantId: z.string().min(1),
  useCase: z.string().min(1),
  generatedAt: z.string().min(1),
  exportedCount: z.number().int().min(0),
  analystSentimentCount: z.number().int().min(0).default(0),
  latestPath: z.string().min(1),
  latestSha256: z.string().length(64),
  snapshotPath: z.string().min(1),
  snapshotSha256: z.string().length(64),
  byEngagementType: z.record(z.string(), z.number().int().min(0)).default({}),
  byQueue: z.record(z.string(), z.number().int().min(0)).default({}),
  byTranscriptLengthBucket: z.record(z.string(), z.number().int().min(0)).default({}),
  latestReviewedAt: z.string().min(1).optional(),
  latestUpdatedAt: z.string().min(1).optional(),
  includeTranscript: z.boolean().default(true),
  requireAnalystSentiment: z.boolean().default(false),
  classification: z.enum(['INTERNAL', 'RESTRICTED']).default('RESTRICTED'),
  retentionDays: z.number().int().min(1).optional(),
  maximumSnapshots: z.number().int().min(1).optional(),
  coverageRequirements: reviewedDatasetCoverageRequirementsSchema.optional(),
  coverageFailures: z.array(z.string()).default([]),
});

export type ReviewedRunExportManifest = z.infer<typeof reviewedRunExportManifestSchema>;

export const reviewedRunExportRefreshResponseSchema = z.object({
  generatedAt: z.string().min(1),
  results: z.array(reviewedRunExportRefreshResultSchema),
  skipped: z.array(z.object({
    tenantId: z.string().min(1),
    useCase: z.string().min(1),
    reason: z.string().min(1),
  })),
});

export type ReviewedRunExportRefreshResponse = z.infer<typeof reviewedRunExportRefreshResponseSchema>;

export const modelValidationThresholdRecommendationRequestSchema = z.object({
  tenantId: z.string().min(1).optional(),
  useCase: z.string().min(1).optional(),
  packVersion: z.string().min(1).optional(),
});

export type ModelValidationThresholdRecommendationRequest = z.input<typeof modelValidationThresholdRecommendationRequestSchema>;

export const reviewedDatasetInventoryFileSchema = z.object({
  path: z.string().min(1),
  format: z.enum(['JSON', 'JSONL']),
  compression: z.enum(['NONE', 'GZIP']),
  snapshot: z.boolean(),
  recordCount: z.number().int().min(0),
  analystSentimentCount: z.number().int().min(0),
  latestUpdatedAt: z.string().min(1).optional(),
});

export type ReviewedDatasetInventoryFile = z.infer<typeof reviewedDatasetInventoryFileSchema>;

export const reviewedDatasetInventoryScopeSchema = z.object({
  tenantId: z.string().min(1),
  useCase: z.string().min(1),
  latestPath: z.string().min(1).optional(),
  snapshotDirectory: z.string().min(1).optional(),
  latestUpdatedAt: z.string().min(1).optional(),
  fileCount: z.number().int().min(0),
  snapshotCount: z.number().int().min(0),
  recordCount: z.number().int().min(0),
  analystSentimentCount: z.number().int().min(0),
  byPackVersion: z.record(z.string(), z.number().int().min(0)).default({}),
  byEngagementType: z.record(z.string(), z.number().int().min(0)).default({}),
  byQueue: z.record(z.string(), z.number().int().min(0)).default({}),
  byTranscriptLengthBucket: z.record(z.string(), z.number().int().min(0)).default({}),
  includeTranscript: z.boolean().optional(),
  requireAnalystSentiment: z.boolean().optional(),
  classification: z.enum(['INTERNAL', 'RESTRICTED']).optional(),
  retentionDays: z.number().int().min(1).optional(),
  maximumSnapshots: z.number().int().min(1).optional(),
  coverageRequirements: reviewedDatasetCoverageRequirementsSchema.optional(),
  coverageFailures: z.array(z.string()).default([]),
  files: z.array(reviewedDatasetInventoryFileSchema).default([]),
});

export type ReviewedDatasetInventoryScope = z.infer<typeof reviewedDatasetInventoryScopeSchema>;

export const reviewedDatasetInventoryListResponseSchema = z.object({
  generatedAt: z.string().min(1),
  scopes: z.array(reviewedDatasetInventoryScopeSchema),
});

export type ReviewedDatasetInventoryListResponse = z.infer<typeof reviewedDatasetInventoryListResponseSchema>;

export const modelValidationThresholdOverrideSchema = z.object({
  minimumReviewedSampleSize: z.number().int().min(1).optional(),
  maximumFailureRate: z.number().min(0).max(1).optional(),
  maximumReviewRate: z.number().min(0).max(1).optional(),
  maximumUncertainRate: z.number().min(0).max(1).optional(),
  minimumSchemaValidRate: z.number().min(0).max(1).optional(),
  maximumAverageDeltaScore100: z.number().min(0).max(100).optional(),
  maximumAverageDeltaScore5: z.number().min(0).max(4).optional(),
  minimumExactScore5MatchRate: z.number().min(0).max(1).optional(),
  minimumWithinFivePointsRate: z.number().min(0).max(1).optional(),
  maximumAverageProcessingDurationMs: z.number().min(1).optional(),
  maximumP95ProcessingDurationMs: z.number().min(1).optional(),
});

export type ModelValidationThresholdOverride = z.infer<typeof modelValidationThresholdOverrideSchema>;

export const modelValidationThresholdsSchema = z.object({
  minimumReviewedSampleSize: z.number().int().min(1).default(10),
  maximumFailureRate: z.number().min(0).max(1).default(0.1),
  maximumReviewRate: z.number().min(0).max(1).default(0.35),
  maximumUncertainRate: z.number().min(0).max(1).default(0.15),
  minimumSchemaValidRate: z.number().min(0).max(1).default(0.98),
  maximumAverageDeltaScore100: z.number().min(0).max(100).default(5),
  maximumAverageDeltaScore5: z.number().min(0).max(4).default(0.5),
  minimumExactScore5MatchRate: z.number().min(0).max(1).default(0.75),
  minimumWithinFivePointsRate: z.number().min(0).max(1).default(0.95),
  maximumAverageProcessingDurationMs: z.number().min(1).default(900000),
  maximumP95ProcessingDurationMs: z.number().min(1).default(1800000),
  byEngagementType: z.record(z.string(), modelValidationThresholdOverrideSchema).default({}),
  byQueue: z.record(z.string(), modelValidationThresholdOverrideSchema).default({}),
  byTranscriptLengthBucket: z.record(z.string(), modelValidationThresholdOverrideSchema).default({}),
});

export type ModelValidationThresholds = z.infer<typeof modelValidationThresholdsSchema>;

export const modelValidationThresholdRecommendationPolicySchema = z.object({
  autoApply: z.boolean().default(false),
  minimumIntervalMinutes: z.number().int().min(1).default(1440),
  minimumRunCount: z.number().int().min(1).default(50),
  minimumReviewedSampleSize: z.number().int().min(1).default(20),
  minimumRunCountPerEngagementType: z.number().int().min(1).default(15),
  minimumReviewedSampleSizePerEngagementType: z.number().int().min(1).default(8),
  minimumRunCountPerQueue: z.number().int().min(1).default(10),
  minimumReviewedSampleSizePerQueue: z.number().int().min(1).default(5),
  minimumRunCountPerTranscriptLengthBucket: z.number().int().min(1).default(10),
  minimumReviewedSampleSizePerTranscriptLengthBucket: z.number().int().min(1).default(5),
  lastAppliedAt: z.string().min(1).optional(),
  lastAppliedPackVersion: z.string().min(1).optional(),
}).default({
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
});

export type ModelValidationThresholdRecommendationPolicy = z.infer<typeof modelValidationThresholdRecommendationPolicySchema>;

const modelValidationLiveBreakdownBucketSchema = z.object({
  runCount: z.number().int().min(0),
  completedRuns: z.number().int().min(0),
  failedRuns: z.number().int().min(0),
  reviewCount: z.number().int().min(0),
  uncertainCount: z.number().int().min(0),
  schemaValidatedRuns: z.number().int().min(0),
  schemaValidRuns: z.number().int().min(0),
  schemaInvalidRuns: z.number().int().min(0),
  failureRate: z.number().min(0).max(1),
  reviewRate: z.number().min(0).max(1),
  uncertainRate: z.number().min(0).max(1),
  schemaValidRate: z.number().min(0).max(1).optional(),
  averageProcessingDurationMs: z.number().min(0).optional(),
  p95ProcessingDurationMs: z.number().min(0).optional(),
});

const modelValidationReviewedBreakdownBucketSchema = z.object({
  total: z.number().int().min(0),
  averageDeltaScore100: z.number().min(0),
  averageDeltaScore5: z.number().min(0),
  exactScore5Matches: z.number().int().min(0),
  exactScore5MatchRate: z.number().min(0).max(1),
  withinFivePointsScore100: z.number().int().min(0),
  withinFivePointsRate: z.number().min(0).max(1),
  correctedCount: z.number().int().min(0),
});

export const modelValidationThresholdRecommendationResponseSchema = z.object({
  generatedAt: z.string().min(1),
  tenantId: z.string().min(1),
  useCase: z.string().min(1),
  packVersion: z.string().min(1).optional(),
  currentThresholds: modelValidationThresholdsSchema,
  recommendedThresholds: modelValidationThresholdsSchema,
  observedLiveMetrics: z.object({
    runCount: z.number().int().min(0),
    failureRate: z.number().min(0).max(1),
    reviewRate: z.number().min(0).max(1),
    uncertainRate: z.number().min(0).max(1),
    schemaValidRate: z.number().min(0).max(1).optional(),
    averageProcessingDurationMs: z.number().min(0).optional(),
    p95ProcessingDurationMs: z.number().min(0).optional(),
    byEngagementType: z.record(z.string(), modelValidationLiveBreakdownBucketSchema).default({}),
    byQueue: z.record(z.string(), modelValidationLiveBreakdownBucketSchema).default({}),
    byTranscriptLengthBucket: z.record(z.string(), modelValidationLiveBreakdownBucketSchema).default({}),
  }),
  observedReviewedMetrics: z.object({
    total: z.number().int().min(0),
    averageDeltaScore100: z.number().min(0),
    averageDeltaScore5: z.number().min(0),
    exactScore5MatchRate: z.number().min(0).max(1),
    withinFivePointsRate: z.number().min(0).max(1),
    byEngagementType: z.record(z.string(), modelValidationReviewedBreakdownBucketSchema).default({}),
    byQueue: z.record(z.string(), modelValidationReviewedBreakdownBucketSchema).default({}),
    byTranscriptLengthBucket: z.record(z.string(), modelValidationReviewedBreakdownBucketSchema).default({}),
  }).optional(),
  notes: z.array(z.string()).default([]),
});

export type ModelValidationThresholdRecommendationResponse = z.infer<typeof modelValidationThresholdRecommendationResponseSchema>;

export const modelValidationThresholdApplyRequestSchema = z.object({
  tenantId: z.string().min(1).optional(),
  useCase: z.string().min(1).optional(),
  packVersion: z.string().min(1).optional(),
  force: z.boolean().default(false),
  enableValidationMonitoring: z.boolean().default(true),
  nightlyIntervalMinutes: z.number().int().min(1).default(1440),
  evaluationWindowHours: z.number().int().min(1).optional(),
  minimumRunCount: z.number().int().min(1).default(50),
  minimumReviewedSampleSize: z.number().int().min(1).default(20),
  minimumRunCountPerEngagementType: z.number().int().min(1).default(15),
  minimumReviewedSampleSizePerEngagementType: z.number().int().min(1).default(8),
  minimumRunCountPerQueue: z.number().int().min(1).default(10),
  minimumReviewedSampleSizePerQueue: z.number().int().min(1).default(5),
  minimumRunCountPerTranscriptLengthBucket: z.number().int().min(1).default(10),
  minimumReviewedSampleSizePerTranscriptLengthBucket: z.number().int().min(1).default(5),
  autoApply: z.boolean().default(false),
});

export type ModelValidationThresholdApplyRequest = z.input<typeof modelValidationThresholdApplyRequestSchema>;

export const modelValidationThresholdApplyResponseSchema = z.object({
  generatedAt: z.string().min(1),
  tenantId: z.string().min(1),
  useCase: z.string().min(1),
  packVersion: z.string().min(1).optional(),
  applied: z.boolean(),
  reason: z.string().min(1).optional(),
  previousThresholds: modelValidationThresholdsSchema,
  appliedThresholds: modelValidationThresholdsSchema,
  validationMonitoring: z.object({
    enabled: z.boolean(),
    minimumIntervalMinutes: z.number().int().min(1),
    evaluationWindowHours: z.number().int().min(1),
    thresholds: modelValidationThresholdsSchema,
    recommendations: modelValidationThresholdRecommendationPolicySchema,
  }),
  recommendation: modelValidationThresholdRecommendationResponseSchema,
});

export type ModelValidationThresholdApplyResponse = z.infer<typeof modelValidationThresholdApplyResponseSchema>;

export const modelValidationAlertKindSchema = z.enum([
  'CANARY_REJECTED',
  'FAILURE_RATE_HIGH',
  'REVIEW_RATE_HIGH',
  'UNCERTAIN_RATE_HIGH',
  'SCHEMA_VALID_RATE_LOW',
  'LATENCY_HIGH',
  'SCORE_DRIFT_HIGH',
  'SCORE_BUCKET_MATCH_LOW',
  'REVIEWED_SAMPLE_SIZE_LOW',
]);

export type ModelValidationAlertKind = z.infer<typeof modelValidationAlertKindSchema>;

export const modelValidationAlertSeveritySchema = z.enum(['INFO', 'WARNING', 'CRITICAL']);
export type ModelValidationAlertSeverity = z.infer<typeof modelValidationAlertSeveritySchema>;

export const modelValidationAlertSchema = z.object({
  alertId: z.string().min(1),
  reportId: z.string().min(1),
  tenantId: z.string().min(1),
  useCase: z.string().min(1),
  packVersion: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  kind: modelValidationAlertKindSchema,
  severity: modelValidationAlertSeveritySchema,
  message: z.string().min(1),
  metricValue: z.number().optional(),
  threshold: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type ModelValidationAlert = z.infer<typeof modelValidationAlertSchema>;

const modelValidationReviewedDatasetSummarySchema = z.object({
  recordCount: z.number().int().min(0),
  analystSentimentCount: z.number().int().min(0),
  fileCount: z.number().int().min(0),
  snapshotCount: z.number().int().min(0),
  latestUpdatedAt: z.string().min(1).optional(),
  datasetAgeHours: z.number().min(0).optional(),
  byEngagementType: z.record(z.string(), z.number().int().min(0)).default({}),
  byQueue: z.record(z.string(), z.number().int().min(0)).default({}),
  byTranscriptLengthBucket: z.record(z.string(), z.number().int().min(0)).default({}),
  coverageRequirements: reviewedDatasetCoverageRequirementsSchema,
  coverageFailures: z.array(z.string()).default([]),
  ready: z.boolean(),
});

export const modelValidationReportSchema = z.object({
  reportId: z.string().min(1),
  tenantId: z.string().min(1),
  useCase: z.string().min(1),
  packVersion: z.string().min(1).optional(),
  generatedAt: z.string().min(1),
  windowStartedAt: z.string().min(1),
  windowEndedAt: z.string().min(1),
  thresholds: modelValidationThresholdsSchema,
  liveMetrics: z.object({
    runCount: z.number().int().min(0),
    completedRuns: z.number().int().min(0),
    failedRuns: z.number().int().min(0),
    reviewCount: z.number().int().min(0),
    uncertainCount: z.number().int().min(0),
    scoredRuns: z.number().int().min(0),
    schemaValidatedRuns: z.number().int().min(0),
    schemaValidRuns: z.number().int().min(0),
    schemaInvalidRuns: z.number().int().min(0),
    failureRate: z.number().min(0).max(1),
    reviewRate: z.number().min(0).max(1),
    uncertainRate: z.number().min(0).max(1),
    schemaValidRate: z.number().min(0).max(1).optional(),
    averageScore100: z.number().min(0).max(100).optional(),
    averageProcessingDurationMs: z.number().min(0).optional(),
    p95ProcessingDurationMs: z.number().min(0).optional(),
    byEngagementType: z.record(z.string(), modelValidationLiveBreakdownBucketSchema).default({}),
    byQueue: z.record(z.string(), modelValidationLiveBreakdownBucketSchema).default({}),
    byTranscriptLengthBucket: z.record(z.string(), modelValidationLiveBreakdownBucketSchema).default({}),
  }),
  reviewedMetrics: z.object({
    total: z.number().int().min(0),
    averageDeltaScore100: z.number().min(0),
    averageDeltaScore5: z.number().min(0),
    maxDeltaScore100: z.number().min(0),
    maxDeltaScore5: z.number().min(0),
    exactScore5Matches: z.number().int().min(0),
    exactScore5MatchRate: z.number().min(0).max(1),
    withinFivePointsScore100: z.number().int().min(0),
    withinFivePointsRate: z.number().min(0).max(1),
    byReviewState: z.record(z.string(), z.number().int().min(0)).default({}),
    byEngagementType: z.record(z.string(), modelValidationReviewedBreakdownBucketSchema).default({}),
    byQueue: z.record(z.string(), modelValidationReviewedBreakdownBucketSchema).default({}),
    byTranscriptLengthBucket: z.record(z.string(), modelValidationReviewedBreakdownBucketSchema).default({}),
    correctedCount: z.number().int().min(0),
  }).optional(),
  regression: z.object({
    previousReportId: z.string().min(1).optional(),
    failureRateDelta: z.number(),
    reviewRateDelta: z.number(),
    uncertainRateDelta: z.number(),
    schemaValidRateDelta: z.number().optional(),
    averageDeltaScore100Delta: z.number().optional(),
    averageProcessingDurationMsDelta: z.number().optional(),
    p95ProcessingDurationMsDelta: z.number().optional(),
  }).optional(),
  reviewedDataset: modelValidationReviewedDatasetSummarySchema.optional(),
  alerts: z.array(modelValidationAlertSchema).default([]),
});

export type ModelValidationReport = z.infer<typeof modelValidationReportSchema>;

export const modelValidationReportListResponseSchema = z.object({
  reports: z.array(modelValidationReportSchema),
});

export type ModelValidationReportListResponse = z.infer<typeof modelValidationReportListResponseSchema>;

export const modelValidationAlertListResponseSchema = z.object({
  alerts: z.array(modelValidationAlertSchema),
});

export type ModelValidationAlertListResponse = z.infer<typeof modelValidationAlertListResponseSchema>;

export const modelValidationRunRequestSchema = z.object({
  tenantId: z.string().min(1).optional(),
  useCase: z.string().min(1).optional(),
  force: z.boolean().default(false),
});

export type ModelValidationRunRequest = z.input<typeof modelValidationRunRequestSchema>;

export const modelValidationRunResponseSchema = z.object({
  generatedAt: z.string().min(1),
  reports: z.array(modelValidationReportSchema),
  skipped: z.array(z.object({
    tenantId: z.string().min(1),
    useCase: z.string().min(1),
    reason: z.string().min(1),
  })),
});

export type ModelValidationRunResponse = z.infer<typeof modelValidationRunResponseSchema>;
