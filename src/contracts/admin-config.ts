import { z } from 'zod';
import {
  reviewedDatasetCoverageRequirementsSchema,
  modelValidationThresholdRecommendationPolicySchema,
  modelValidationThresholdsSchema,
} from './model-validation';

export const reviewAssignmentModeSchema = z.enum([
  'MANUAL',
  'AUTO_ASSIGN_SELF',
]);

export type ReviewAssignmentMode = z.infer<typeof reviewAssignmentModeSchema>;

export const tenantAdminReviewWorkflowSchema = z.object({
  sla: z.object({
    pendingTargetMinutes: z.number().int().min(1).default(60),
    assignedTargetMinutes: z.number().int().min(1).default(30),
  }).default({
    pendingTargetMinutes: 60,
    assignedTargetMinutes: 30,
  }),
  assignment: z.object({
    mode: reviewAssignmentModeSchema.default('MANUAL'),
    requireAssignmentBeforeDecision: z.boolean().default(false),
  }).default({
    mode: 'MANUAL',
    requireAssignmentBeforeDecision: false,
  }),
}).default({
  sla: {
    pendingTargetMinutes: 60,
    assignedTargetMinutes: 30,
  },
  assignment: {
    mode: 'MANUAL',
    requireAssignmentBeforeDecision: false,
  },
});

export type TenantAdminReviewWorkflow = z.infer<typeof tenantAdminReviewWorkflowSchema>;

export const tenantAdminCanaryAutomationSchema = z.object({
  enabled: z.boolean().default(false),
  minimumIntervalMinutes: z.number().int().min(1).default(60),
  evaluationWindowHours: z.number().int().min(1).default(168),
  applyResult: z.boolean().default(false),
  noteTemplate: z.string().trim().min(1).max(2000).optional(),
}).default({
  enabled: false,
  minimumIntervalMinutes: 60,
  evaluationWindowHours: 168,
  applyResult: false,
});

export type TenantAdminCanaryAutomation = z.infer<typeof tenantAdminCanaryAutomationSchema>;

export const tenantAdminValidationMonitoringSchema = z.object({
  enabled: z.boolean().default(false),
  minimumIntervalMinutes: z.number().int().min(1).default(1440),
  evaluationWindowHours: z.number().int().min(1).default(168),
  thresholds: modelValidationThresholdsSchema.default({
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
  }),
  recommendations: modelValidationThresholdRecommendationPolicySchema,
  reviewedExports: z.object({
    includeTranscript: z.boolean().default(true),
    requireAnalystSentiment: z.boolean().default(false),
    classification: z.enum(['INTERNAL', 'RESTRICTED']).default('RESTRICTED'),
    retentionDays: z.number().int().min(1).default(30),
    maximumSnapshots: z.number().int().min(1).default(30),
  }).default({
    includeTranscript: true,
    requireAnalystSentiment: false,
    classification: 'RESTRICTED',
    retentionDays: 30,
    maximumSnapshots: 30,
  }),
  reviewedDatasetReadiness: reviewedDatasetCoverageRequirementsSchema.default({
    minimumRecordCount: 0,
    minimumAnalystSentimentCount: 0,
    maximumDatasetAgeHours: undefined,
    byEngagementType: {},
    byQueue: {},
    byTranscriptLengthBucket: {},
  }),
}).default({
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
  reviewedExports: {
    includeTranscript: true,
    requireAnalystSentiment: false,
    classification: 'RESTRICTED',
    retentionDays: 30,
    maximumSnapshots: 30,
  },
  reviewedDatasetReadiness: {
    minimumRecordCount: 0,
    minimumAnalystSentimentCount: 0,
    byEngagementType: {},
    byQueue: {},
    byTranscriptLengthBucket: {},
  },
});

export type TenantAdminValidationMonitoring = z.infer<typeof tenantAdminValidationMonitoringSchema>;

const sentimentScoreOffsetByPolaritySchema = z.object({
  VERY_NEGATIVE: z.number().int().min(-20).max(20).optional(),
  NEGATIVE: z.number().int().min(-20).max(20).optional(),
  NEUTRAL: z.number().int().min(-20).max(20).optional(),
  POSITIVE: z.number().int().min(-20).max(20).optional(),
  VERY_POSITIVE: z.number().int().min(-20).max(20).optional(),
});

export const tenantAdminSentimentScoringSchema = z.object({
  enabled: z.boolean().default(false),
  defaultScore100Offset: z.number().int().min(-20).max(20).default(0),
  byEngagementType: z.object({
    CALL: z.number().int().min(-20).max(20).optional(),
    EMAIL: z.number().int().min(-20).max(20).optional(),
    TICKET: z.number().int().min(-20).max(20).optional(),
    CHAT: z.number().int().min(-20).max(20).optional(),
  }).default({}),
  byPolarity: sentimentScoreOffsetByPolaritySchema.default({}),
  byEngagementTypeAndPolarity: z.object({
    CALL: sentimentScoreOffsetByPolaritySchema.optional(),
    EMAIL: sentimentScoreOffsetByPolaritySchema.optional(),
    TICKET: sentimentScoreOffsetByPolaritySchema.optional(),
    CHAT: sentimentScoreOffsetByPolaritySchema.optional(),
  }).default({}),
}).default({
  enabled: false,
  defaultScore100Offset: 0,
  byEngagementType: {},
  byPolarity: {},
  byEngagementTypeAndPolarity: {},
});

export type TenantAdminSentimentScoring = z.infer<typeof tenantAdminSentimentScoringSchema>;

export const tenantAdminConfigSchema = z.object({
  tenantId: z.string().min(1),
  useCase: z.string().default('support'),
  reviewWorkflow: tenantAdminReviewWorkflowSchema,
  canaryAutomation: tenantAdminCanaryAutomationSchema,
  validationMonitoring: tenantAdminValidationMonitoringSchema,
  sentimentScoring: tenantAdminSentimentScoringSchema,
  updatedAt: z.string().min(1),
});

export type TenantAdminConfig = z.infer<typeof tenantAdminConfigSchema>;
export const tenantAdminConfigInputSchema = tenantAdminConfigSchema.omit({ updatedAt: true }).extend({
  updatedAt: z.string().min(1).optional(),
});

export type TenantAdminConfigDraft = z.input<typeof tenantAdminConfigInputSchema>;

export function buildDefaultTenantAdminConfig(
  tenantId: string,
  useCase = 'support',
  updatedAt = new Date().toISOString(),
): TenantAdminConfig {
  return tenantAdminConfigSchema.parse({
    tenantId,
    useCase,
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
      reviewedExports: {
        includeTranscript: true,
        requireAnalystSentiment: false,
        classification: 'RESTRICTED',
        retentionDays: 30,
        maximumSnapshots: 30,
      },
      reviewedDatasetReadiness: {
        minimumRecordCount: 0,
        minimumAnalystSentimentCount: 0,
        byEngagementType: {},
        byQueue: {},
        byTranscriptLengthBucket: {},
      },
    },
    sentimentScoring: {
      enabled: false,
      defaultScore100Offset: 0,
      byEngagementType: {},
    },
    updatedAt,
  });
}

export const tenantAdminConfigUpdateRequestSchema = z.object({
  config: tenantAdminConfigInputSchema,
});

export type TenantAdminConfigUpdateRequest = z.input<typeof tenantAdminConfigUpdateRequestSchema>;

export const tenantAdminConfigResponseSchema = z.object({
  config: tenantAdminConfigSchema,
});

export type TenantAdminConfigResponse = z.infer<typeof tenantAdminConfigResponseSchema>;
