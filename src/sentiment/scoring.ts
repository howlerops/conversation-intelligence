import { z } from 'zod';
import { OverallSentiment } from '../contracts/analysis';
import type { TenantAdminSentimentScoring } from '../contracts/admin-config';
import { transcriptLengthBucketSchema } from '../contracts/model-validation';

export const sentimentCalibrationFixtureSchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1).optional(),
  reviewedBy: z.string().min(1).optional(),
  reviewedAt: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
  sentiment: z.object({
    polarity: z.enum(['VERY_NEGATIVE', 'NEGATIVE', 'NEUTRAL', 'POSITIVE', 'VERY_POSITIVE']),
    intensity: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1),
  }),
  expected: z.object({
    score100: z.number().int().min(0).max(100),
    score5: z.number().int().min(1).max(5),
    score100Tolerance: z.number().int().min(0).max(100).default(0),
    score5Tolerance: z.number().int().min(0).max(4).default(0),
  }),
});

export const sentimentCalibrationFixturesSchema = z.array(sentimentCalibrationFixtureSchema);

export type SentimentCalibrationFixture = z.infer<typeof sentimentCalibrationFixtureSchema>;

export const reviewedSentimentOutcomeSampleSchema = z.object({
  runId: z.string().min(1).optional(),
  tenantId: z.string().min(1).optional(),
  useCase: z.string().min(1).default('support'),
  source: z.enum(['fixture', 'review_export', 'real_data']).default('fixture'),
  engagementType: z.enum(['CALL', 'EMAIL', 'TICKET', 'CHAT']).optional(),
  queue: z.string().min(1).optional(),
  transcriptTurnCount: z.number().int().min(0).optional(),
  transcriptCharacterCount: z.number().int().min(0).optional(),
  transcriptLengthBucket: transcriptLengthBucketSchema.optional(),
  sourceDataset: z.string().min(1).optional(),
  datasetTrack: z.enum(['OPEN_CORE', 'RESEARCH_ONLY', 'SYNTHETIC']).optional(),
  name: z.string().min(1),
  category: z.string().min(1).optional(),
  reviewedBy: z.string().min(1).optional(),
  reviewedAt: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
  model: z.object({
    polarity: z.enum(['VERY_NEGATIVE', 'NEGATIVE', 'NEUTRAL', 'POSITIVE', 'VERY_POSITIVE']),
    intensity: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1),
  }),
  analyst: z.object({
    score100: z.number().int().min(0).max(100),
    score5: z.number().int().min(1).max(5),
    reviewState: z.enum(['VERIFIED', 'UNCERTAIN', 'NEEDS_REVIEW']).optional(),
    correctionApplied: z.boolean().default(false),
  }),
});

export const reviewedSentimentOutcomeSamplesSchema = z.array(reviewedSentimentOutcomeSampleSchema);

export type ReviewedSentimentOutcomeSample = z.infer<typeof reviewedSentimentOutcomeSampleSchema>;

export interface SentimentScoreContext {
  engagementType?: 'CALL' | 'EMAIL' | 'TICKET' | 'CHAT';
  polarity?: OverallSentiment['polarity'];
}

export interface SentimentScoringRecommendation {
  sampleSize: number;
  averageSignedDeltaScore100: number;
  recommendedScore100Offset: number;
}

export interface SentimentScoringRecommendationSummary {
  recommendedConfig: TenantAdminSentimentScoring;
  overall: SentimentScoringRecommendation;
  byEngagementType: Partial<Record<NonNullable<SentimentScoreContext['engagementType']>, SentimentScoringRecommendation>>;
}

type SentimentScoreMethod =
  | 'derived_v1'
  | 'derived_v1_calibrated'
  | 'model_v1'
  | 'model_v1_calibrated';

export function deriveScore5FromScore100(score100: number): number {
  const bounded = Math.max(0, Math.min(100, Math.round(score100)));
  return Math.min(5, Math.floor(Math.max(bounded - 1, 0) / 20) + 1);
}

export function resolveSentimentScore100Offset(
  config?: TenantAdminSentimentScoring,
  context?: SentimentScoreContext,
): number {
  if (!config?.enabled) {
    return 0;
  }

  const engagementType = context?.engagementType;
  const polarity = context?.polarity;
  if (engagementType && polarity) {
    const scopedByEngagementAndPolarity = config.byEngagementTypeAndPolarity[engagementType]?.[polarity];
    if (typeof scopedByEngagementAndPolarity === 'number') {
      return scopedByEngagementAndPolarity;
    }
  }

  if (engagementType) {
    const scopedByEngagement = config.byEngagementType[engagementType];
    if (typeof scopedByEngagement === 'number') {
      return scopedByEngagement;
    }
  }

  if (polarity) {
    const scopedByPolarity = config.byPolarity[polarity];
    if (typeof scopedByPolarity === 'number') {
      return scopedByPolarity;
    }
  }

  return config.defaultScore100Offset;
}

export function deriveSentimentScore(
  input: Pick<OverallSentiment, 'polarity' | 'intensity'>,
  options: {
    score100Offset?: number;
    context?: SentimentScoreContext;
  } = {},
): NonNullable<OverallSentiment['score']> {
  const boundedIntensity = Math.max(0, Math.min(1, input.intensity));
  let score100 = 50;

  if (input.polarity === 'NEGATIVE' || input.polarity === 'VERY_NEGATIVE') {
    score100 = Math.round(50 - (boundedIntensity * 50));
  } else if (input.polarity === 'POSITIVE' || input.polarity === 'VERY_POSITIVE') {
    score100 = Math.round(50 + (boundedIntensity * 50));
  }

  const offset = Math.max(-20, Math.min(20, Math.round(options.score100Offset ?? 0)));
  score100 = Math.max(0, Math.min(100, score100 + offset));

  return {
    method: offset === 0 ? 'derived_v1' : 'derived_v1_calibrated',
    score100,
    score5: deriveScore5FromScore100(score100),
    calibration: offset === 0
      ? undefined
      : {
        score100Offset: offset,
        engagementType: options.context?.engagementType,
      },
  };
}

function applyScore100Offset(score100: number, offsetInput: number | undefined): { score100: number; offset: number } {
  const boundedScore100 = Math.max(0, Math.min(100, Math.round(score100)));
  const offset = Math.max(-20, Math.min(20, Math.round(offsetInput ?? 0)));
  return {
    score100: Math.max(0, Math.min(100, boundedScore100 + offset)),
    offset,
  };
}

function resolveCalibratedMethod(
  input: SentimentScoreMethod,
  offset: number,
): SentimentScoreMethod {
  if (input === 'model_v1' || input === 'model_v1_calibrated') {
    return offset === 0 ? 'model_v1' : 'model_v1_calibrated';
  }
  return offset === 0 ? 'derived_v1' : 'derived_v1_calibrated';
}

export function applyAdditionalSentimentScoreOffset(
  score: NonNullable<OverallSentiment['score']>,
  options: {
    additionalScore100Offset?: number;
    context?: SentimentScoreContext;
  } = {},
): NonNullable<OverallSentiment['score']> {
  const additionalOffset = Math.max(-20, Math.min(20, Math.round(options.additionalScore100Offset ?? 0)));
  const existingOffset = score.calibration?.score100Offset ?? 0;
  const score100 = Math.max(0, Math.min(100, Math.round(score.score100 + additionalOffset)));
  const totalOffset = Math.max(-20, Math.min(20, existingOffset + additionalOffset));

  return {
    method: resolveCalibratedMethod(score.method, totalOffset),
    score100,
    score5: deriveScore5FromScore100(score100),
    calibration: totalOffset === 0
      ? undefined
      : {
        score100Offset: totalOffset,
        engagementType: options.context?.engagementType,
      },
  };
}

export function calibrateExistingSentimentScore(
  score: NonNullable<OverallSentiment['score']>,
  options: {
    score100Offset?: number;
    context?: SentimentScoreContext;
  } = {},
): NonNullable<OverallSentiment['score']> {
  const { score100, offset } = applyScore100Offset(score.score100, options.score100Offset);
  return applyAdditionalSentimentScoreOffset({
    ...score,
    score100,
    score5: deriveScore5FromScore100(score100),
    calibration: offset === 0
      ? undefined
      : {
        score100Offset: offset,
        engagementType: options.context?.engagementType,
      },
  }, {
    additionalScore100Offset: 0,
    context: options.context,
  });
}

export function enrichOverallSentimentScore(
  sentiment: OverallSentiment | null,
  options: {
    scoringConfig?: TenantAdminSentimentScoring;
    context?: SentimentScoreContext;
  } = {},
): OverallSentiment | null {
  if (!sentiment) {
    return null;
  }

  const contextWithPolarity: SentimentScoreContext = {
    ...options.context,
    polarity: sentiment.polarity,
  };
  const score100Offset = resolveSentimentScore100Offset(options.scoringConfig, contextWithPolarity);

  if (sentiment.score) {
    return {
      ...sentiment,
      score: calibrateExistingSentimentScore(sentiment.score, {
        score100Offset,
        context: contextWithPolarity,
      }),
    };
  }

  return {
    ...sentiment,
    score: deriveSentimentScore(sentiment, {
      score100Offset,
      context: contextWithPolarity,
    }),
  };
}

export function recommendSentimentScoringConfig(
  samples: unknown,
  options: {
    minimumSampleSize?: number;
    minimumSampleSizePerEngagementType?: number;
  } = {},
): SentimentScoringRecommendationSummary {
  const parsed = reviewedSentimentOutcomeSamplesSchema.parse(samples);
  const minimumSampleSize = options.minimumSampleSize ?? 10;
  const minimumSampleSizePerEngagementType = options.minimumSampleSizePerEngagementType ?? 5;

  const overall = buildRecommendation(parsed);
  const scopedSamples = new Map<NonNullable<SentimentScoreContext['engagementType']>, ReviewedSentimentOutcomeSample[]>();

  for (const sample of parsed) {
    if (!sample.engagementType) {
      continue;
    }

    const existing = scopedSamples.get(sample.engagementType) ?? [];
    existing.push(sample);
    scopedSamples.set(sample.engagementType, existing);
  }

  const byEngagementType: SentimentScoringRecommendationSummary['byEngagementType'] = {};
  for (const [engagementType, engagementSamples] of scopedSamples.entries()) {
    if (engagementSamples.length < minimumSampleSizePerEngagementType) {
      continue;
    }
    byEngagementType[engagementType] = buildRecommendation(engagementSamples);
  }

  return {
    recommendedConfig: {
      enabled: overall.sampleSize >= minimumSampleSize
        || Object.keys(byEngagementType).length > 0,
      defaultScore100Offset: overall.sampleSize >= minimumSampleSize
        ? overall.recommendedScore100Offset
        : 0,
      byEngagementType: {
        CALL: byEngagementType.CALL?.recommendedScore100Offset,
        EMAIL: byEngagementType.EMAIL?.recommendedScore100Offset,
        TICKET: byEngagementType.TICKET?.recommendedScore100Offset,
        CHAT: byEngagementType.CHAT?.recommendedScore100Offset,
      },
      byPolarity: {},
      byEngagementTypeAndPolarity: {},
    },
    overall,
    byEngagementType,
  };
}

function buildRecommendation(samples: ReviewedSentimentOutcomeSample[]): SentimentScoringRecommendation {
  const signedDeltas = samples.map((sample) => {
    const derived = deriveSentimentScore(sample.model);
    return sample.analyst.score100 - derived.score100;
  });
  const averageSignedDeltaScore100 = signedDeltas.length === 0
    ? 0
    : Number((signedDeltas.reduce((sum, value) => sum + value, 0) / signedDeltas.length).toFixed(2));

  return {
    sampleSize: samples.length,
    averageSignedDeltaScore100,
    recommendedScore100Offset: Math.max(-20, Math.min(20, Math.round(averageSignedDeltaScore100))),
  };
}
