import { z } from 'zod';
import { sentimentPolaritySchema } from './roles';
import { sentimentTrendPointSchema } from './sentiment-persistence';

// ---------------------------------------------------------------------------
// Confusion pair — a single predicted→actual misclassification bucket.
// ---------------------------------------------------------------------------

export const confusionPairSchema = z.object({
  predicted: sentimentPolaritySchema,
  actual: sentimentPolaritySchema,
  count: z.number().int().min(1),
  percentage: z.number().min(0).max(100),
});

export type ConfusionPair = z.infer<typeof confusionPairSchema>;

// ---------------------------------------------------------------------------
// Calibration analysis result — confusion matrix + inferred root causes.
// ---------------------------------------------------------------------------

const engagementTypeCalibrationSchema = z.object({
  sampleSize: z.number().int().min(0),
  avgSignedDelta: z.number(),
  avgAbsoluteDelta: z.number(),
  confusionPairs: z.array(confusionPairSchema),
});

export const calibrationAnalysisResultSchema = z.object({
  tenantId: z.string().min(1),
  sampleSize: z.number().int().min(0),
  avgSignedDelta: z.number(),
  avgAbsoluteDelta: z.number(),
  confusionPairs: z.array(confusionPairSchema),
  rootCauses: z.array(z.string()),
  byEngagementType: z.record(z.string(), engagementTypeCalibrationSchema).optional(),
});

export type CalibrationAnalysisResult = z.infer<typeof calibrationAnalysisResultSchema>;

// ---------------------------------------------------------------------------
// Drift detection result — baseline vs recent score comparison.
// ---------------------------------------------------------------------------

export const driftDetectionResultSchema = z.object({
  tenantId: z.string().min(1),
  baselineAvgScore100: z.number().min(0).max(100),
  recentAvgScore100: z.number().min(0).max(100),
  drift: z.number(),
  driftSignificant: z.boolean(),
  trendDirection: z.enum(['improving', 'declining', 'stable']),
  baselineSampleSize: z.number().int().min(0),
  recentSampleSize: z.number().int().min(0),
  sparkline: z.array(sentimentTrendPointSchema),
});

export type DriftDetectionResult = z.infer<typeof driftDetectionResultSchema>;

// ---------------------------------------------------------------------------
// Calibration offset recommendation — actionable score100 offset to apply.
// ---------------------------------------------------------------------------

const engagementTypeOffsetSchema = z.object({
  recommendedScore100Offset: z.number().int().min(-20).max(20),
  sampleSize: z.number().int().min(0),
  avgSignedDelta: z.number(),
});

export const calibrationOffsetRecommendationSchema = z.object({
  tenantId: z.string().min(1),
  recommendedScore100Offset: z.number().int().min(-20).max(20),
  sampleSize: z.number().int().min(0),
  confidence: z.enum(['low', 'medium', 'high']),
  byEngagementType: z.record(z.string(), engagementTypeOffsetSchema).optional(),
});

export type CalibrationOffsetRecommendation = z.infer<typeof calibrationOffsetRecommendationSchema>;

// ---------------------------------------------------------------------------
// Calibration convergence — tracks MAE over time windows.
// ---------------------------------------------------------------------------

export const calibrationConvergenceWindowSchema = z.object({
  windowStart: z.string().min(1),
  windowEnd: z.string().min(1),
  sampleSize: z.number().int().min(0),
  mae: z.number().min(0),
});

export type CalibrationConvergenceWindow = z.infer<typeof calibrationConvergenceWindowSchema>;

export const calibrationConvergenceResultSchema = z.object({
  tenantId: z.string().min(1),
  windows: z.array(calibrationConvergenceWindowSchema),
  trend: z.enum(['converging', 'oscillating', 'stable', 'insufficient_data']),
  overallMae: z.number().min(0),
  latestMae: z.number().min(0),
  maeChangeRate: z.number(),
  windowCount: z.number().int().min(0),
  minimumWindowsRequired: z.number().int().min(1),
});

export type CalibrationConvergenceResult = z.infer<typeof calibrationConvergenceResultSchema>;
