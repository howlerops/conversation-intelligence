import { z } from 'zod';
import { canonicalRoleSchema, impactLevelSchema, sentimentPolaritySchema } from './roles';
import { supportCanonicalEventTypeSchema } from './tenant-pack';

const engagementTypeSchema = z.enum(['CALL', 'EMAIL', 'TICKET', 'CHAT']);

export type EngagementType = z.infer<typeof engagementTypeSchema>;

const scoringMethodSchema = z.enum([
  'derived_v1',
  'derived_v1_calibrated',
  'model_v1',
  'model_v1_calibrated',
]);

// ---------------------------------------------------------------------------
// Sentiment analysis record — one per completed analysis job.
// Flat columns (no JSONB) for efficient SQL filtering, GROUP BY, and AVG.
// ---------------------------------------------------------------------------

export const sentimentAnalysisRecordSchema = z.object({
  jobId: z.string().min(1),
  tenantId: z.string().min(1),
  conversationId: z.string().optional(),
  useCase: z.string().min(1),
  engagementType: engagementTypeSchema.optional(),
  polarity: sentimentPolaritySchema,
  intensity: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  score100: z.number().int().min(0).max(100),
  score5: z.number().int().min(1).max(5),
  scoringMethod: scoringMethodSchema.optional(),
  calibrationOffset: z.number().int().min(-20).max(20).optional(),
  aspectCount: z.number().int().min(0),
  eventCount: z.number().int().min(0),
  keyMomentCount: z.number().int().min(0),
  analyzedAt: z.string().min(1),
  packVersion: z.string().min(1).optional(),
});

export type SentimentAnalysisRecord = z.infer<typeof sentimentAnalysisRecordSchema>;

// ---------------------------------------------------------------------------
// Sentiment segment — per-turn text records for phrase search.
// The `text` column gets a tsvector GIN index in Postgres.
// ---------------------------------------------------------------------------

export const sentimentSegmentRecordSchema = z.object({
  segmentId: z.string().min(1),
  jobId: z.string().min(1),
  tenantId: z.string().min(1),
  turnId: z.string().min(1),
  speakerRole: canonicalRoleSchema,
  text: z.string().min(1),
  polarity: sentimentPolaritySchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  aspectTarget: z.string().min(1).optional(),
  aspectName: z.string().min(1).optional(),
});

export type SentimentSegmentRecord = z.infer<typeof sentimentSegmentRecordSchema>;

// ---------------------------------------------------------------------------
// Key moment record — persisted canonical key moments for querying.
// ---------------------------------------------------------------------------

export const keyMomentRecordSchema = z.object({
  momentId: z.string().min(1),
  jobId: z.string().min(1),
  tenantId: z.string().min(1),
  type: supportCanonicalEventTypeSchema,
  actorRole: canonicalRoleSchema,
  startTurnId: z.string().min(1),
  endTurnId: z.string().min(1),
  confidence: z.number().min(0).max(1),
  businessImpact: impactLevelSchema,
  rationale: z.string().min(1),
  evidenceJson: z.string().min(1),
});

export type KeyMomentRecord = z.infer<typeof keyMomentRecordSchema>;

// ---------------------------------------------------------------------------
// Calibration sample — ground truth from analyst reviews stored alongside
// model predictions so accuracy diff is a single scan.
// ---------------------------------------------------------------------------

export const calibrationSampleRecordSchema = z.object({
  sampleId: z.string().min(1),
  jobId: z.string().min(1),
  tenantId: z.string().min(1),
  useCase: z.string().min(1),
  engagementType: engagementTypeSchema.optional(),
  modelPolarity: sentimentPolaritySchema,
  modelIntensity: z.number().min(0).max(1),
  modelConfidence: z.number().min(0).max(1),
  modelScore100: z.number().int().min(0).max(100),
  modelScore5: z.number().int().min(1).max(5),
  analystScore100: z.number().int().min(0).max(100),
  analystScore5: z.number().int().min(1).max(5),
  deltaScore100: z.number().int().min(-100).max(100),
  deltaScore5: z.number().int().min(-4).max(4),
  correctionApplied: z.boolean(),
  createdAt: z.string().min(1),
});

export type CalibrationSampleRecord = z.infer<typeof calibrationSampleRecordSchema>;

// ---------------------------------------------------------------------------
// Trend point — time-bucketed aggregation for sparkline charts.
// ---------------------------------------------------------------------------

export const sentimentTrendPointSchema = z.object({
  bucket: z.string().min(1),
  avgScore100: z.number().min(0).max(100),
  avgScore5: z.number().min(1).max(5),
  count: z.number().int().min(0),
  avgConfidence: z.number().min(0).max(1),
});

export type SentimentTrendPoint = z.infer<typeof sentimentTrendPointSchema>;

// ---------------------------------------------------------------------------
// Phrase search result — segment with highlighted snippet.
// ---------------------------------------------------------------------------

export const phraseSearchResultSchema = z.object({
  segment: sentimentSegmentRecordSchema,
  headline: z.string().min(1),
  rank: z.number().min(0),
});

export type PhraseSearchResult = z.infer<typeof phraseSearchResultSchema>;
