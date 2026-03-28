import { z } from 'zod';
import {
  canonicalRoleSchema,
  impactLevelSchema,
  reviewStateSchema,
  sentimentPolaritySchema,
} from './roles';
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

export const reviewSchema = z.object({
  state: reviewStateSchema,
  reasons: z.array(z.string()).default([]),
});

export type Review = z.infer<typeof reviewSchema>;

export const canonicalExtractionSchema = z.object({
  overallEndUserSentiment: overallSentimentSchema.nullable(),
  aspectSentiments: z.array(aspectSentimentSchema).default([]),
  canonicalEvents: z.array(canonicalEventSchema).default([]),
  canonicalKeyMoments: z.array(canonicalKeyMomentSchema).default([]),
  summary: z.string().min(1),
  review: reviewSchema.default({
    state: 'VERIFIED',
    reasons: [],
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
    engine: z.enum(['rlm', 'stub']),
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
});

export type ReviewQueueItem = z.infer<typeof reviewQueueItemSchema>;
