import { toJSONSchema } from 'zod';
import { tenantAdminConfigUpdateRequestSchema } from './admin-config';
import { analysisRequestSchema, analysisJobRecordSchema } from './jobs';
import {
  modelValidationThresholdApplyRequestSchema,
  modelValidationRunRequestSchema,
  modelValidationThresholdRecommendationRequestSchema,
  reviewedRunExportRefreshRequestSchema,
  reviewedRunExportRequestSchema,
} from './model-validation';
import {
  conversationAnalysisSchema,
  reviewAssignmentRequestSchema,
  reviewCommentRequestSchema,
  reviewDecisionRequestSchema,
} from './analysis';
import {
  tenantPackApproveRequestSchema,
  tenantPackAutoEvaluateCanaryRequestSchema,
  tenantPackCommentRequestSchema,
  tenantPackEvaluateCanaryRequestSchema,
  tenantPackPublishRequestSchema,
  tenantPackRollbackRequestSchema,
  tenantPackSchema,
} from './tenant-pack';
import { transcriptInputSchema } from './transcript';

export interface RegisteredSchemaVersion {
  version: string;
  generatedAt: string;
  schemas: Record<string, unknown>;
}

export function getRegisteredSchemaVersion(version: string): RegisteredSchemaVersion | null {
  if (version !== 'v1') {
    return null;
  }

  return {
    version: 'v1',
    generatedAt: new Date().toISOString(),
    schemas: {
      analysisRequest: toJSONSchema(analysisRequestSchema),
      analysisJobRecord: toJSONSchema(analysisJobRecordSchema),
      conversationAnalysis: toJSONSchema(conversationAnalysisSchema),
      tenantPack: toJSONSchema(tenantPackSchema),
      transcriptInput: toJSONSchema(transcriptInputSchema),
      reviewDecisionRequest: toJSONSchema(reviewDecisionRequestSchema),
      reviewAssignmentRequest: toJSONSchema(reviewAssignmentRequestSchema),
      reviewCommentRequest: toJSONSchema(reviewCommentRequestSchema),
      tenantPackPublishRequest: toJSONSchema(tenantPackPublishRequestSchema),
      tenantPackApproveRequest: toJSONSchema(tenantPackApproveRequestSchema),
      tenantAdminConfigUpdateRequest: toJSONSchema(tenantAdminConfigUpdateRequestSchema),
      tenantPackCommentRequest: toJSONSchema(tenantPackCommentRequestSchema),
      tenantPackAutoEvaluateCanaryRequest: toJSONSchema(tenantPackAutoEvaluateCanaryRequestSchema),
      tenantPackEvaluateCanaryRequest: toJSONSchema(tenantPackEvaluateCanaryRequestSchema),
      tenantPackRollbackRequest: toJSONSchema(tenantPackRollbackRequestSchema),
      reviewedRunExportRequest: toJSONSchema(reviewedRunExportRequestSchema),
      reviewedRunExportRefreshRequest: toJSONSchema(reviewedRunExportRefreshRequestSchema),
      modelValidationRunRequest: toJSONSchema(modelValidationRunRequestSchema),
      modelValidationThresholdRecommendationRequest: toJSONSchema(modelValidationThresholdRecommendationRequestSchema),
      modelValidationThresholdApplyRequest: toJSONSchema(modelValidationThresholdApplyRequestSchema),
    },
  };
}
