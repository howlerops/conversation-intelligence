import { z } from 'zod';
import {
  canonicalRoleSchema,
  impactLevelSchema,
  reviewStateSchema,
  sentimentPolaritySchema,
} from './roles';
import {
  analystSentimentLabelInputSchema,
  analystSentimentLabelSchema,
} from './model-validation';
import { piiRedactionSummarySchema } from './pii';
import { supportCanonicalEventTypeSchema } from './tenant-pack';

export const evidenceReferenceSchema = z.object({
  turnId: z.string().min(1),
  speakerRole: canonicalRoleSchema,
  quote: z.string().min(1),
});

export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;

export const speakerAssignmentSchema = z.object({
  turnId: z.string().min(1),
  speakerId: z.string().min(1),
  displayName: z.string().min(1),
  role: canonicalRoleSchema,
  confidence: z.number().min(0).max(1),
  provenance: z.array(z.string()).min(1),
  markers: z.array(z.string()).default([]),
  eligibleForSentiment: z.boolean(),
  eligibleForKeyMoments: z.boolean(),
});

export type SpeakerAssignment = z.infer<typeof speakerAssignmentSchema>;

export const overallSentimentSchema = z.object({
  polarity: sentimentPolaritySchema,
  intensity: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  score: z.object({
    method: z.enum(['derived_v1', 'derived_v1_calibrated', 'model_v1', 'model_v1_calibrated']),
    score100: z.number().int().min(0).max(100),
    score5: z.number().int().min(1).max(5),
    calibration: z.object({
      score100Offset: z.number().int().min(-20).max(20),
      engagementType: z.enum(['CALL', 'EMAIL', 'TICKET', 'CHAT']).optional(),
    }).optional(),
  }).optional(),
});

export type OverallSentiment = z.infer<typeof overallSentimentSchema>;

export const aspectSentimentSchema = z.object({
  target: z.string().min(1),
  aspect: z.string().min(1),
  literalSentiment: sentimentPolaritySchema,
  intendedSentiment: sentimentPolaritySchema,
  sarcasm: z.boolean().default(false),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  evidence: z.array(evidenceReferenceSchema).min(1),
});

export type AspectSentiment = z.infer<typeof aspectSentimentSchema>;

export const canonicalEventSchema = z.object({
  type: supportCanonicalEventTypeSchema,
  actorRole: canonicalRoleSchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  businessImpact: impactLevelSchema,
  evidence: z.array(evidenceReferenceSchema).min(1),
});

export type CanonicalEvent = z.infer<typeof canonicalEventSchema>;

export const canonicalKeyMomentSchema = z.object({
  type: supportCanonicalEventTypeSchema,
  actorRole: canonicalRoleSchema,
  startTurnId: z.string().min(1),
  endTurnId: z.string().min(1),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  businessImpact: impactLevelSchema,
  evidence: z.array(evidenceReferenceSchema).min(1),
});

export type CanonicalKeyMoment = z.infer<typeof canonicalKeyMomentSchema>;

export const tenantMappedEventSchema = z.object({
  canonicalType: supportCanonicalEventTypeSchema,
  tenantLabel: z.string().min(1),
  severity: impactLevelSchema,
});

export type TenantMappedEvent = z.infer<typeof tenantMappedEventSchema>;

const reviewActorTypeSchema = z.enum(['ANONYMOUS', 'USER', 'SERVICE', 'API_KEY', 'SYSTEM']);

export const reviewWorkflowPolicySummarySchema = z.object({
  pendingTargetMinutes: z.number().int().min(1),
  assignedTargetMinutes: z.number().int().min(1),
  assignmentMode: z.enum(['MANUAL', 'AUTO_ASSIGN_SELF']),
  requireAssignmentBeforeDecision: z.boolean(),
});

export type ReviewWorkflowPolicySummary = z.infer<typeof reviewWorkflowPolicySummarySchema>;

export const reviewCommentSchema = z.object({
  commentId: z.string().min(1),
  actorId: z.string().min(1),
  actorType: reviewActorTypeSchema,
  createdAt: z.string().min(1),
  text: z.string().trim().min(1).max(2000),
});

export type ReviewComment = z.infer<typeof reviewCommentSchema>;

export const reviewSchema = z.object({
  state: reviewStateSchema,
  reasons: z.array(z.string()).default([]),
  analystSentiment: analystSentimentLabelSchema.optional(),
  assignment: z.object({
    assigneeId: z.string().min(1),
    assigneeType: reviewActorTypeSchema,
    assignedById: z.string().min(1),
    assignedByType: reviewActorTypeSchema,
    assignedAt: z.string().min(1),
    note: z.string().trim().min(1).max(2000).optional(),
  }).optional(),
  comments: z.array(reviewCommentSchema).default([]),
  resolution: z.object({
    decision: z.enum(['VERIFY', 'MARK_UNCERTAIN', 'KEEP_NEEDS_REVIEW']),
    resultingState: reviewStateSchema,
    note: z.string().trim().min(1).max(2000).optional(),
    decidedAt: z.string().min(1),
    actorId: z.string().min(1),
    actorType: reviewActorTypeSchema,
  }).optional(),
  history: z.array(z.object({
    kind: z.enum(['ASSIGNED', 'COMMENT', 'DECISION']),
    actedAt: z.string().min(1),
    actorId: z.string().min(1),
    actorType: reviewActorTypeSchema,
    note: z.string().trim().min(1).max(2000).optional(),
    assigneeId: z.string().min(1).optional(),
    assigneeType: reviewActorTypeSchema.optional(),
    decision: z.enum(['VERIFY', 'MARK_UNCERTAIN', 'KEEP_NEEDS_REVIEW']).optional(),
    resultingState: reviewStateSchema.optional(),
  })).default([]),
});

export type Review = z.infer<typeof reviewSchema>;

export const reviewDecisionActionSchema = z.enum([
  'VERIFY',
  'MARK_UNCERTAIN',
  'KEEP_NEEDS_REVIEW',
]);

export type ReviewDecisionAction = z.infer<typeof reviewDecisionActionSchema>;

export const reviewDecisionRequestSchema = z.object({
  decision: reviewDecisionActionSchema,
  note: z.string().trim().min(1).max(2000).optional(),
  sentimentLabel: analystSentimentLabelInputSchema.optional(),
});

export type ReviewDecisionRequest = z.infer<typeof reviewDecisionRequestSchema>;

export const reviewAssignmentRequestSchema = z.object({
  note: z.string().trim().min(1).max(2000).optional(),
});

export type ReviewAssignmentRequest = z.infer<typeof reviewAssignmentRequestSchema>;

export const reviewCommentRequestSchema = z.object({
  comment: z.string().trim().min(1).max(2000),
});

export type ReviewCommentRequest = z.infer<typeof reviewCommentRequestSchema>;

export const canonicalExtractionSchema = z.object({
  overallEndUserSentiment: overallSentimentSchema.nullable(),
  aspectSentiments: z.array(aspectSentimentSchema).default([]),
  canonicalEvents: z.array(canonicalEventSchema).default([]),
  canonicalKeyMoments: z.array(canonicalKeyMomentSchema).default([]),
  summary: z.string().min(1),
  review: reviewSchema.default({
    state: 'VERIFIED',
    reasons: [],
    comments: [],
    history: [],
  }),
});

export type CanonicalExtraction = z.infer<typeof canonicalExtractionSchema>;

export const conversationAnalysisSchema = z.object({
  jobId: z.string().min(1),
  tenantId: z.string().min(1),
  conversationId: z.string().optional(),
  useCase: z.string().min(1),
  analysisScope: z.object({
    sentimentRoles: z.array(canonicalRoleSchema),
    keyMomentRoles: z.array(canonicalRoleSchema),
  }),
  speakerSummary: z.object({
    resolvedRoles: z.array(canonicalRoleSchema),
    confidence: z.number().min(0).max(1),
  }),
  overallEndUserSentiment: overallSentimentSchema.nullable(),
  aspectSentiments: z.array(aspectSentimentSchema),
  canonicalEvents: z.array(canonicalEventSchema),
  canonicalKeyMoments: z.array(canonicalKeyMomentSchema),
  tenantMappedEvents: z.array(tenantMappedEventSchema),
  speakerAssignments: z.array(speakerAssignmentSchema),
  review: reviewSchema,
  piiRedactionSummary: piiRedactionSummarySchema.optional(),
  summary: z.string().min(1),
  trace: z.object({
    engine: z.enum(['rlm', 'rules']),
    model: z.string().optional(),
    packVersion: z.string().min(1),
    promptVersion: z.string().min(1),
    generatedAt: z.string().min(1),
  }),
});

export type ConversationAnalysis = z.infer<typeof conversationAnalysisSchema>;

export const reviewQueueItemSchema = z.object({
  jobId: z.string().min(1),
  tenantId: z.string().min(1),
  conversationId: z.string().optional(),
  review: reviewSchema,
  severity: impactLevelSchema,
  createdAt: z.string().min(1),
  policy: reviewWorkflowPolicySummarySchema.optional(),
});

export type ReviewQueueItem = z.infer<typeof reviewQueueItemSchema>;

export const reviewAnalyticsSchema = z.object({
  generatedAt: z.string().min(1),
  pendingCount: z.number().int().min(0),
  assignedCount: z.number().int().min(0),
  decisionCounts: z.object({
    VERIFY: z.number().int().min(0),
    MARK_UNCERTAIN: z.number().int().min(0),
    KEEP_NEEDS_REVIEW: z.number().int().min(0),
  }),
  resultingStateCounts: z.object({
    VERIFIED: z.number().int().min(0),
    UNCERTAIN: z.number().int().min(0),
    NEEDS_REVIEW: z.number().int().min(0),
  }),
  byActor: z.array(z.object({
    actorId: z.string().min(1),
    actorType: reviewActorTypeSchema,
    decisionCount: z.number().int().min(0),
  })),
  sla: z.object({
    pendingTargetMinutes: z.number().int().min(1),
    assignedTargetMinutes: z.number().int().min(1),
    overdueCount: z.number().int().min(0),
    unassignedOverdueCount: z.number().int().min(0),
    assignedOverdueCount: z.number().int().min(0),
    oldestPendingAgeMinutes: z.number().int().min(0),
    oldestAssignedAgeMinutes: z.number().int().min(0),
    configuredPolicies: z.array(z.object({
      tenantId: z.string().min(1),
      useCase: z.string().min(1),
      pendingTargetMinutes: z.number().int().min(1),
      assignedTargetMinutes: z.number().int().min(1),
      assignmentMode: z.enum(['MANUAL', 'AUTO_ASSIGN_SELF']),
      requireAssignmentBeforeDecision: z.boolean(),
      runCount: z.number().int().min(0),
    })).default([]),
  }),
});

export type ReviewAnalytics = z.infer<typeof reviewAnalyticsSchema>;
