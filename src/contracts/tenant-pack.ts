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
]);

export type SupportCanonicalEventType = z.infer<typeof supportCanonicalEventTypeSchema>;

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
});

export type TenantPack = z.infer<typeof tenantPackSchema>;
export type TenantPackDraft = z.input<typeof tenantPackSchema>;
