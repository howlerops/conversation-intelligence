import { z } from 'zod';
import { E2eBenchmarkSummary, e2eBenchmarkSummarySchema } from './e2e-benchmark';
import { KeyMomentEvalSummary, keyMomentEvalSummarySchema } from './key-moment-evaluation';

// ---------------------------------------------------------------------------
// Model trial result — one benchmark run for one model configuration.
// ---------------------------------------------------------------------------

export const modelTrialResultSchema = z.object({
  modelId: z.string().min(1),
  modelName: z.string().min(1),
  provider: z.string().min(1),
  apiBase: z.string().min(1).optional(),
  benchmarkSummary: e2eBenchmarkSummarySchema,
  keyMomentSummary: keyMomentEvalSummarySchema.optional(),
  runAt: z.string().min(1),
  durationMs: z.number().int().min(0),
  costEstimateUsd: z.number().min(0).optional(),
});

export type ModelTrialResult = z.infer<typeof modelTrialResultSchema>;

// ---------------------------------------------------------------------------
// Model ranking entry — computed comparison metric for sorting.
// ---------------------------------------------------------------------------

export const modelRankingEntrySchema = z.object({
  rank: z.number().int().min(1),
  modelId: z.string().min(1),
  modelName: z.string().min(1),
  provider: z.string().min(1),
  compositeScore: z.number().min(0).max(100),
  metrics: z.object({
    averageDeltaScore100: z.number().optional(),
    withinFivePointsRate: z.number().optional(),
    exactScore5MatchRate: z.number().optional(),
    reviewStateMatchRate: z.number().optional(),
    failureRate: z.number().min(0).max(1),
    averageDurationMs: z.number().min(0),
    keyMomentF1: z.number().min(0).max(1).optional(),
    evidenceFidelity: z.number().min(0).max(1).optional(),
  }),
});

export type ModelRankingEntry = z.infer<typeof modelRankingEntrySchema>;

// ---------------------------------------------------------------------------
// Cross-model comparison report.
// ---------------------------------------------------------------------------

export const crossModelComparisonSchema = z.object({
  generatedAt: z.string().min(1),
  suiteId: z.string().min(1),
  totalRecords: z.number().int().min(0),
  models: z.array(modelTrialResultSchema),
  rankings: z.array(modelRankingEntrySchema),
  bestOverall: z.string().min(1),
  bestAccuracy: z.string().min(1),
  bestSpeed: z.string().min(1),
  bestKeyMoments: z.string().min(1).optional(),
});

export type CrossModelComparison = z.infer<typeof crossModelComparisonSchema>;

// ---------------------------------------------------------------------------
// Model config for the comparison runner.
// ---------------------------------------------------------------------------

export const modelConfigSchema = z.object({
  modelId: z.string().min(1),
  modelName: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  apiKey: z.string().optional(),
  apiBase: z.string().optional(),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;

// ---------------------------------------------------------------------------
// Compute composite score and rank models.
// ---------------------------------------------------------------------------

export function rankModels(
  results: ModelTrialResult[],
): ModelRankingEntry[] {
  const scored = results.map((result) => {
    const overall = result.benchmarkSummary.overall;

    const accuracyScore = computeAccuracyScore(overall);
    const speedScore = computeSpeedScore(overall);
    const reliabilityScore = computeReliabilityScore(overall);
    const keyMomentScore = result.keyMomentSummary
      ? result.keyMomentSummary.macroF1 * 100
      : 0;

    const compositeScore = Number((
      accuracyScore * 0.40 +
      reliabilityScore * 0.25 +
      keyMomentScore * 0.20 +
      speedScore * 0.15
    ).toFixed(2));

    return {
      modelId: result.modelId,
      modelName: result.modelName,
      provider: result.provider,
      compositeScore,
      metrics: {
        averageDeltaScore100: overall.averageDeltaScore100,
        withinFivePointsRate: overall.withinFivePointsRate,
        exactScore5MatchRate: overall.exactScore5MatchRate,
        reviewStateMatchRate: overall.reviewStateMatchRate,
        failureRate: overall.total === 0 ? 0 : Number((overall.failed / overall.total).toFixed(4)),
        averageDurationMs: overall.averageDurationMs,
        keyMomentF1: result.keyMomentSummary?.macroF1,
        evidenceFidelity: result.keyMomentSummary?.averageEvidenceFidelity,
      },
    };
  });

  scored.sort((a, b) => b.compositeScore - a.compositeScore);

  return scored.map((entry, index) => modelRankingEntrySchema.parse({
    rank: index + 1,
    ...entry,
  }));
}

// ---------------------------------------------------------------------------
// Build the full comparison report.
// ---------------------------------------------------------------------------

export function buildCrossModelComparison(
  suiteId: string,
  results: ModelTrialResult[],
): CrossModelComparison {
  const rankings = rankModels(results);

  const bestAccuracy = [...rankings]
    .filter((r) => r.metrics.averageDeltaScore100 !== undefined)
    .sort((a, b) => (a.metrics.averageDeltaScore100 ?? 100) - (b.metrics.averageDeltaScore100 ?? 100))[0];

  const bestSpeed = [...rankings]
    .sort((a, b) => a.metrics.averageDurationMs - b.metrics.averageDurationMs)[0];

  const bestKm = [...rankings]
    .filter((r) => r.metrics.keyMomentF1 !== undefined)
    .sort((a, b) => (b.metrics.keyMomentF1 ?? 0) - (a.metrics.keyMomentF1 ?? 0))[0];

  return crossModelComparisonSchema.parse({
    generatedAt: new Date().toISOString(),
    suiteId,
    totalRecords: results[0]?.benchmarkSummary.totalRecords ?? 0,
    models: results,
    rankings,
    bestOverall: rankings[0]?.modelId ?? 'unknown',
    bestAccuracy: bestAccuracy?.modelId ?? rankings[0]?.modelId ?? 'unknown',
    bestSpeed: bestSpeed?.modelId ?? rankings[0]?.modelId ?? 'unknown',
    bestKeyMoments: bestKm?.modelId,
  });
}

// ---------------------------------------------------------------------------
// Format comparison as a markdown table.
// ---------------------------------------------------------------------------

export function formatComparisonTable(comparison: CrossModelComparison): string {
  const lines: string[] = [
    `# Cross-Model Comparison — ${comparison.suiteId}`,
    `Generated: ${comparison.generatedAt}`,
    `Records: ${comparison.totalRecords}`,
    '',
    '| Rank | Model | Provider | Composite | Avg Delta | Within 5pts | Score5 Match | Failure Rate | Avg ms | KM F1 |',
    '|------|-------|----------|-----------|-----------|-------------|--------------|--------------|--------|-------|',
  ];

  for (const r of comparison.rankings) {
    lines.push(
      `| ${r.rank} | ${r.modelName} | ${r.provider} | ${r.compositeScore} | ${r.metrics.averageDeltaScore100?.toFixed(1) ?? '-'} | ${((r.metrics.withinFivePointsRate ?? 0) * 100).toFixed(0)}% | ${((r.metrics.exactScore5MatchRate ?? 0) * 100).toFixed(0)}% | ${(r.metrics.failureRate * 100).toFixed(1)}% | ${r.metrics.averageDurationMs.toFixed(0)} | ${r.metrics.keyMomentF1?.toFixed(2) ?? '-'} |`,
    );
  }

  lines.push('');
  lines.push(`Best overall: **${comparison.bestOverall}**`);
  lines.push(`Best accuracy: **${comparison.bestAccuracy}**`);
  lines.push(`Best speed: **${comparison.bestSpeed}**`);
  if (comparison.bestKeyMoments) {
    lines.push(`Best key moments: **${comparison.bestKeyMoments}**`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

function computeAccuracyScore(aggregate: { averageDeltaScore100?: number; withinFivePointsRate?: number; exactScore5MatchRate?: number }): number {
  const delta = aggregate.averageDeltaScore100 ?? 10;
  const deltaScore = Math.max(0, 100 - delta * 10);
  const within5 = (aggregate.withinFivePointsRate ?? 0) * 100;
  const exact = (aggregate.exactScore5MatchRate ?? 0) * 100;
  return (deltaScore * 0.4 + within5 * 0.35 + exact * 0.25);
}

function computeSpeedScore(aggregate: { averageDurationMs: number }): number {
  if (aggregate.averageDurationMs <= 500) return 100;
  if (aggregate.averageDurationMs >= 10000) return 0;
  return Math.max(0, 100 - (aggregate.averageDurationMs - 500) / 95);
}

function computeReliabilityScore(aggregate: { total: number; failed: number; reviewCount: number; uncertainCount: number }): number {
  if (aggregate.total === 0) return 0;
  const failureRate = aggregate.failed / aggregate.total;
  const reviewRate = aggregate.total === 0 ? 0 : aggregate.reviewCount / aggregate.total;
  const failureScore = Math.max(0, 100 - failureRate * 1000);
  const reviewScore = Math.max(0, 100 - reviewRate * 200);
  return failureScore * 0.6 + reviewScore * 0.4;
}
