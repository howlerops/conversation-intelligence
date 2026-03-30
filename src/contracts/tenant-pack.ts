import { z } from 'zod';
import { canonicalRoleSchema, impactLevelSchema } from './roles';

export const supportCanonicalEventTypeSchema = z.enum([
  'FRUSTRATION_ONSET',
  'POLICY_CONFLICT',
  'PROMISE_BROKEN',
  'REPEAT_CONTACT_SIGNAL',
  'RESOLUTION_COMMITMENT',
  'RESOLUTION_REJECTION',
  'ESCALATION_REQUEST',
  'REFUND_DELAY',
  'DOCUMENT_BLOCKER',
  'HARDSHIP_SIGNAL',
  'PROMISE_TO_PAY',
]);

export type SupportCanonicalEventType = z.infer<typeof supportCanonicalEventTypeSchema>;

export const canonicalEventDefinitionSchema = z.object({
  /** One-line description used in the LLM prompt (what this event means, when to emit it). */
  description: z.string().min(1),
  /** Canonical actor role that typically generates this event. */
  actorRole: z.enum(['END_USER', 'AGENT', 'SYSTEM', 'END_USER_OR_AGENT', 'END_USER_OR_SYSTEM']).optional(),
  /**
   * Representative example phrases from real conversations.
   * Used to build the embedding space for semantic trigger detection.
   * At least 3 phrases recommended; 5-8 gives best coverage.
   */
  examplePhrases: z.array(z.string().min(1)).default([]),
});

export type CanonicalEventDefinition = z.infer<typeof canonicalEventDefinitionSchema>;

export const tenantPackSchema = z.object({
  tenantId: z.string().min(1),
  packVersion: z.string().min(1),
  useCase: z.string().default('support'),
  roleAliases: z.record(z.string(), canonicalRoleSchema).default({}),
  speakerIdRoleMap: z.record(z.string(), canonicalRoleSchema).default({}),
  ignoredSpeakerPatterns: z.array(z.string()).default([]),
  analysisPolicy: z.object({
    sentimentRoles: z.array(canonicalRoleSchema).default(['END_USER']),
    keyMomentRoles: z.array(canonicalRoleSchema).default(['END_USER']),
    contextRoles: z.array(canonicalRoleSchema).default([
      'END_USER',
      'AGENT',
      'SUPERVISOR',
      'ADMIN',
      'SYSTEM',
      'BOT',
      'UNKNOWN',
    ]),
    speakerConfidenceReviewThreshold: z.number().min(0).max(1).default(0.8),
  }).default({
    sentimentRoles: ['END_USER'],
    keyMomentRoles: ['END_USER'],
    contextRoles: ['END_USER', 'AGENT', 'SUPERVISOR', 'ADMIN', 'SYSTEM', 'BOT', 'UNKNOWN'],
    speakerConfidenceReviewThreshold: 0.8,
  }),
  reviewThresholds: z.object({
    minimumSpeakerSummaryConfidence: z.number().min(0).max(1).default(0.85),
    minimumOverallSentimentConfidence: z.number().min(0).max(1).default(0.65),
    minimumAspectConfidence: z.number().min(0).max(1).default(0.65),
    minimumEventConfidence: z.number().min(0).max(1).default(0.7),
    minimumKeyMomentConfidence: z.number().min(0).max(1).default(0.75),
    minimumHighImpactEvidenceCount: z.number().int().min(1).default(1),
  }).default({
    minimumSpeakerSummaryConfidence: 0.85,
    minimumOverallSentimentConfidence: 0.65,
    minimumAspectConfidence: 0.65,
    minimumEventConfidence: 0.7,
    minimumKeyMomentConfidence: 0.75,
    minimumHighImpactEvidenceCount: 1,
  }),
  taxonomy: z.object({
    canonicalToTenant: z.record(z.string(), z.string()).default({}),
    defaultSeverity: z.record(z.string(), impactLevelSchema).default({}),
  }).default({
    canonicalToTenant: {},
    defaultSeverity: {},
  }),
  policyDigest: z.array(z.string()).default([]),
  supportedCanonicalEventTypes: z.array(supportCanonicalEventTypeSchema).default([
    'FRUSTRATION_ONSET',
    'POLICY_CONFLICT',
    'PROMISE_BROKEN',
    'REPEAT_CONTACT_SIGNAL',
    'RESOLUTION_COMMITMENT',
    'RESOLUTION_REJECTION',
    'ESCALATION_REQUEST',
    'REFUND_DELAY',
  ]),
  /**
   * Per-event-type definitions used to build the analysis prompt and semantic trigger embeddings
   * dynamically. When present, the engine uses these instead of any hardcoded defaults.
   * Keys are the canonical event type strings (e.g. "FRUSTRATION_ONSET").
   */
  canonicalEventDefinitions: z.record(z.string(), canonicalEventDefinitionSchema).default({}),
});

export type TenantPack = z.infer<typeof tenantPackSchema>;
export type TenantPackDraft = z.input<typeof tenantPackSchema>;

export const compiledTenantPackSchema = z.object({
  tenantId: z.string().min(1),
  packVersion: z.string().min(1),
  useCase: z.string().min(1),
  compiledAt: z.string().min(1),
  runtimePack: tenantPackSchema,
  digest: z.object({
    roleAliasCount: z.number().int().min(0),
    speakerIdRoleCount: z.number().int().min(0),
    policyDigestEntryCount: z.number().int().min(0),
    canonicalMappingCount: z.number().int().min(0),
    supportedEventTypeCount: z.number().int().min(0),
  }),
  warnings: z.array(z.string()).default([]),
});

export type CompiledTenantPack = z.infer<typeof compiledTenantPackSchema>;

const tenantPackActorTypeSchema = z.enum(['ANONYMOUS', 'USER', 'SERVICE', 'API_KEY', 'SYSTEM']);
const tenantPackMetadataSchema = z.record(z.string(), z.unknown()).default({});

export const tenantPackReleaseModeSchema = z.enum([
  'DIRECT',
  'APPROVAL_REQUIRED',
  'CANARY',
]);

export type TenantPackReleaseMode = z.infer<typeof tenantPackReleaseModeSchema>;

export const tenantPackReleaseStatusSchema = z.enum([
  'ACTIVE',
  'PENDING_APPROVAL',
  'CANARY',
  'SUPERSEDED',
  'REJECTED',
]);

export type TenantPackReleaseStatus = z.infer<typeof tenantPackReleaseStatusSchema>;

export const tenantPackReleaseActorSchema = z.object({
  actorId: z.string().min(1),
  actorType: tenantPackActorTypeSchema,
});

export type TenantPackReleaseActor = z.infer<typeof tenantPackReleaseActorSchema>;

export const tenantPackReleaseApprovalSchema = tenantPackReleaseActorSchema.extend({
  approvedAt: z.string().min(1),
  note: z.string().trim().min(1).max(2000).optional(),
});

export type TenantPackReleaseApproval = z.infer<typeof tenantPackReleaseApprovalSchema>;

export const tenantPackCanaryPolicySchema = z.object({
  minimumSampleSize: z.number().int().min(1).default(25),
  maximumFailureRate: z.number().min(0).max(1).default(0.1),
  maximumReviewRate: z.number().min(0).max(1).default(0.35),
  maximumUncertainRate: z.number().min(0).max(1).default(0.15),
  minimumAverageScore100: z.number().int().min(0).max(100).optional(),
});

export type TenantPackCanaryPolicy = z.infer<typeof tenantPackCanaryPolicySchema>;

export const tenantPackCanaryObservedMetricsSchema = z.object({
  sampleSize: z.number().int().min(0),
  completedRuns: z.number().int().min(0).optional(),
  failedRuns: z.number().int().min(0).optional(),
  failureRate: z.number().min(0).max(1),
  reviewCount: z.number().int().min(0).optional(),
  reviewRate: z.number().min(0).max(1),
  uncertainCount: z.number().int().min(0).optional(),
  uncertainRate: z.number().min(0).max(1),
  scoredRuns: z.number().int().min(0).optional(),
  averageScore100: z.number().min(0).max(100).optional(),
  windowStartedAt: z.string().min(1).optional(),
  windowEndedAt: z.string().min(1).optional(),
});

export type TenantPackCanaryObservedMetrics = z.infer<typeof tenantPackCanaryObservedMetricsSchema>;

export const tenantPackCanaryDecisionSchema = z.enum(['PASS', 'FAIL']);
export type TenantPackCanaryDecision = z.infer<typeof tenantPackCanaryDecisionSchema>;

export const tenantPackCanaryEvaluationSchema = z.object({
  evaluationId: z.string().min(1),
  decidedAt: z.string().min(1),
  actorId: z.string().min(1).optional(),
  actorType: tenantPackActorTypeSchema.optional(),
  decision: tenantPackCanaryDecisionSchema,
  summary: z.string().min(1),
  metrics: tenantPackCanaryObservedMetricsSchema,
  policy: tenantPackCanaryPolicySchema,
  blockingReasons: z.array(z.string()).default([]),
  note: z.string().trim().min(1).max(2000).optional(),
  applied: z.boolean().default(false),
});

export type TenantPackCanaryEvaluation = z.infer<typeof tenantPackCanaryEvaluationSchema>;

export const tenantPackReleaseHistoryEntryKindSchema = z.enum([
  'PUBLISHED',
  'COMMENTED',
  'APPROVED',
  'CANARY_STARTED',
  'CANARY_EVALUATED',
  'ACTIVATED',
  'ROLLED_BACK',
  'SUPERSEDED',
  'REJECTED',
]);

export type TenantPackReleaseHistoryEntryKind = z.infer<typeof tenantPackReleaseHistoryEntryKindSchema>;

export const tenantPackReleaseHistoryEntrySchema = z.object({
  entryId: z.string().min(1),
  kind: tenantPackReleaseHistoryEntryKindSchema,
  createdAt: z.string().min(1),
  actorId: z.string().min(1).optional(),
  actorType: tenantPackActorTypeSchema.optional(),
  note: z.string().trim().min(1).max(2000).optional(),
  status: tenantPackReleaseStatusSchema.optional(),
  metadata: tenantPackMetadataSchema,
});

export type TenantPackReleaseHistoryEntry = z.infer<typeof tenantPackReleaseHistoryEntrySchema>;

export const tenantPackReleaseCanarySchema = z.object({
  percentage: z.number().int().min(1).max(100),
  startedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional(),
  result: tenantPackCanaryDecisionSchema.optional(),
  note: z.string().trim().min(1).max(2000).optional(),
  policy: tenantPackCanaryPolicySchema.optional(),
  evaluations: z.array(tenantPackCanaryEvaluationSchema).default([]),
});

export type TenantPackReleaseCanary = z.infer<typeof tenantPackReleaseCanarySchema>;

export const tenantPackReleaseSchema = z.object({
  tenantId: z.string().min(1),
  useCase: z.string().min(1),
  packVersion: z.string().min(1),
  mode: tenantPackReleaseModeSchema,
  status: tenantPackReleaseStatusSchema,
  note: z.string().trim().min(1).max(2000).optional(),
  approvalsRequired: z.number().int().min(0).default(0),
  approvals: z.array(tenantPackReleaseApprovalSchema).default([]),
  canary: tenantPackReleaseCanarySchema.optional(),
  history: z.array(tenantPackReleaseHistoryEntrySchema).default([]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  activatedAt: z.string().min(1).optional(),
  activatedById: z.string().min(1).optional(),
  activatedByType: tenantPackActorTypeSchema.optional(),
  supersededAt: z.string().min(1).optional(),
  rejectedAt: z.string().min(1).optional(),
});

export type TenantPackRelease = z.infer<typeof tenantPackReleaseSchema>;

export const tenantPackReleaseControlSchema = z.object({
  mode: tenantPackReleaseModeSchema.default('DIRECT'),
  approvalsRequired: z.number().int().min(1).max(10).optional(),
  canaryPercentage: z.number().int().min(1).max(100).optional(),
  canaryPolicy: tenantPackCanaryPolicySchema.optional(),
  note: z.string().trim().min(1).max(2000).optional(),
});

export type TenantPackReleaseControl = z.infer<typeof tenantPackReleaseControlSchema>;

export const tenantPackValidateRequestSchema = z.object({
  tenantPack: tenantPackSchema,
});

export type TenantPackValidateRequest = z.input<typeof tenantPackValidateRequestSchema>;

export const tenantPackPreviewResponseSchema = z.object({
  valid: z.literal(true),
  compiledPack: compiledTenantPackSchema,
});

export type TenantPackPreviewResponse = z.infer<typeof tenantPackPreviewResponseSchema>;

export const tenantPackPublishRequestSchema = z.object({
  tenantPack: tenantPackSchema,
  release: tenantPackReleaseControlSchema.optional(),
});
export type TenantPackPublishRequest = z.input<typeof tenantPackPublishRequestSchema>;

export const tenantPackPublishResponseSchema = z.object({
  activeVersion: z.string().min(1).optional(),
  previousVersion: z.string().min(1).optional(),
  compiledPack: compiledTenantPackSchema,
  release: tenantPackReleaseSchema,
  availableVersions: z.array(z.string().min(1)),
});

export type TenantPackPublishResponse = z.infer<typeof tenantPackPublishResponseSchema>;

export const tenantPackRollbackRequestSchema = z.object({
  tenantId: z.string().min(1),
  useCase: z.string().default('support'),
  targetPackVersion: z.string().min(1),
  note: z.string().trim().min(1).max(2000).optional(),
});

export type TenantPackRollbackRequest = z.input<typeof tenantPackRollbackRequestSchema>;

export const tenantPackRollbackResponseSchema = z.object({
  activeVersion: z.string().min(1),
  previousVersion: z.string().min(1).optional(),
  compiledPack: compiledTenantPackSchema,
  release: tenantPackReleaseSchema,
  availableVersions: z.array(z.string().min(1)),
});

export type TenantPackRollbackResponse = z.infer<typeof tenantPackRollbackResponseSchema>;

export const tenantPackApproveRequestSchema = z.object({
  tenantId: z.string().min(1),
  useCase: z.string().default('support'),
  targetPackVersion: z.string().min(1),
  note: z.string().trim().min(1).max(2000).optional(),
});

export type TenantPackApproveRequest = z.input<typeof tenantPackApproveRequestSchema>;

export const tenantPackApproveResponseSchema = z.object({
  activeVersion: z.string().min(1).optional(),
  previousVersion: z.string().min(1).optional(),
  release: tenantPackReleaseSchema,
  availableVersions: z.array(z.string().min(1)),
});

export type TenantPackApproveResponse = z.infer<typeof tenantPackApproveResponseSchema>;

export const tenantPackPromoteRequestSchema = z.object({
  tenantId: z.string().min(1),
  useCase: z.string().default('support'),
  targetPackVersion: z.string().min(1),
  result: tenantPackCanaryDecisionSchema.default('PASS'),
  note: z.string().trim().min(1).max(2000).optional(),
});

export type TenantPackPromoteRequest = z.input<typeof tenantPackPromoteRequestSchema>;

export const tenantPackPromoteResponseSchema = z.object({
  activeVersion: z.string().min(1).optional(),
  previousVersion: z.string().min(1).optional(),
  release: tenantPackReleaseSchema,
  availableVersions: z.array(z.string().min(1)),
});

export type TenantPackPromoteResponse = z.infer<typeof tenantPackPromoteResponseSchema>;

export const tenantPackCommentRequestSchema = z.object({
  tenantId: z.string().min(1),
  useCase: z.string().default('support'),
  targetPackVersion: z.string().min(1),
  comment: z.string().trim().min(1).max(2000),
});

export type TenantPackCommentRequest = z.input<typeof tenantPackCommentRequestSchema>;

export const tenantPackCommentResponseSchema = z.object({
  activeVersion: z.string().min(1).optional(),
  previousVersion: z.string().min(1).optional(),
  release: tenantPackReleaseSchema,
  availableVersions: z.array(z.string().min(1)),
});

export type TenantPackCommentResponse = z.infer<typeof tenantPackCommentResponseSchema>;

export const tenantPackEvaluateCanaryRequestSchema = z.object({
  tenantId: z.string().min(1),
  useCase: z.string().default('support'),
  targetPackVersion: z.string().min(1),
  metrics: tenantPackCanaryObservedMetricsSchema,
  policy: tenantPackCanaryPolicySchema.optional(),
  applyResult: z.boolean().default(false),
  note: z.string().trim().min(1).max(2000).optional(),
});

export type TenantPackEvaluateCanaryRequest = z.input<typeof tenantPackEvaluateCanaryRequestSchema>;

export const tenantPackEvaluateCanaryResponseSchema = z.object({
  activeVersion: z.string().min(1).optional(),
  previousVersion: z.string().min(1).optional(),
  release: tenantPackReleaseSchema,
  evaluation: tenantPackCanaryEvaluationSchema,
  availableVersions: z.array(z.string().min(1)),
});

export type TenantPackEvaluateCanaryResponse = z.infer<typeof tenantPackEvaluateCanaryResponseSchema>;

export const tenantPackAutoEvaluateCanaryRequestSchema = z.object({
  tenantId: z.string().min(1),
  useCase: z.string().default('support'),
  targetPackVersion: z.string().min(1).optional(),
  applyResult: z.boolean().optional(),
  force: z.boolean().default(false),
  note: z.string().trim().min(1).max(2000).optional(),
});

export type TenantPackAutoEvaluateCanaryRequest = z.input<typeof tenantPackAutoEvaluateCanaryRequestSchema>;

export const tenantPackAutoEvaluateCanaryResponseSchema = z.object({
  attempted: z.boolean(),
  skippedReason: z.string().min(1).optional(),
  configApplied: z.object({
    minimumIntervalMinutes: z.number().int().min(1),
    evaluationWindowHours: z.number().int().min(1),
    applyResult: z.boolean(),
  }).optional(),
  result: tenantPackEvaluateCanaryResponseSchema.optional(),
});

export type TenantPackAutoEvaluateCanaryResponse = z.infer<typeof tenantPackAutoEvaluateCanaryResponseSchema>;

export const tenantPackStateSchema = z.object({
  tenantId: z.string().min(1),
  useCase: z.string().min(1),
  activeVersion: z.string().min(1).optional(),
  availableVersions: z.array(z.string().min(1)),
  activePack: compiledTenantPackSchema.nullable(),
  releases: z.array(tenantPackReleaseSchema).default([]),
});

export type TenantPackState = z.infer<typeof tenantPackStateSchema>;
