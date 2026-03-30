import { describe, expect, it } from 'vitest';
import {
  rankModels,
  buildCrossModelComparison,
  formatComparisonTable,
  ModelTrialResult,
} from '../src/validation/cross-model-comparison';
import { E2eBenchmarkSummary } from '../src/validation/e2e-benchmark';

function makeTrialResult(overrides: Partial<ModelTrialResult> & { modelId: string }): ModelTrialResult {
  const summary: E2eBenchmarkSummary = {
    totalRecords: 50,
    bySource: {},
    byEngagementType: {},
    byQueue: {},
    byTranscriptLengthBucket: {},
    overall: {
      total: 50,
      completed: 48,
      failed: 2,
      compared: 45,
      reviewCount: 5,
      uncertainCount: 2,
      averageDurationMs: 1000,
      p95DurationMs: 3000,
      averageDeltaScore100: 4.0,
      averageDeltaScore5: 0.8,
      exactScore5MatchRate: 0.80,
      withinFivePointsRate: 0.85,
      reviewStateMatchRate: 0.88,
    },
  };

  return {
    modelName: overrides.modelId,
    provider: 'test',
    benchmarkSummary: summary,
    runAt: new Date().toISOString(),
    durationMs: 30000,
    ...overrides,
  };
}

describe('cross-model comparison', () => {
  it('ranks models by composite score with accuracy weighted highest', () => {
    const results: ModelTrialResult[] = [
      makeTrialResult({
        modelId: 'model-accurate',
        modelName: 'Accurate Model',
        benchmarkSummary: {
          ...makeTrialResult({ modelId: 'x' }).benchmarkSummary,
          overall: {
            ...makeTrialResult({ modelId: 'x' }).benchmarkSummary.overall,
            averageDeltaScore100: 2.0,
            withinFivePointsRate: 0.95,
            exactScore5MatchRate: 0.90,
            averageDurationMs: 1500,
          },
        },
      }),
      makeTrialResult({
        modelId: 'model-fast',
        modelName: 'Fast Model',
        benchmarkSummary: {
          ...makeTrialResult({ modelId: 'x' }).benchmarkSummary,
          overall: {
            ...makeTrialResult({ modelId: 'x' }).benchmarkSummary.overall,
            averageDeltaScore100: 6.0,
            withinFivePointsRate: 0.70,
            exactScore5MatchRate: 0.60,
            averageDurationMs: 200,
          },
        },
      }),
    ];

    const rankings = rankModels(results);
    expect(rankings[0].modelId).toBe('model-accurate');
    expect(rankings[0].rank).toBe(1);
    expect(rankings[1].modelId).toBe('model-fast');
    expect(rankings[1].rank).toBe(2);
    expect(rankings[0].compositeScore).toBeGreaterThan(rankings[1].compositeScore);
  });

  it('builds a full comparison report with best-of categories', () => {
    const results: ModelTrialResult[] = [
      makeTrialResult({ modelId: 'gpt-4o', modelName: 'GPT-4o', provider: 'openai' }),
      makeTrialResult({
        modelId: 'claude-sonnet',
        modelName: 'Claude Sonnet',
        provider: 'anthropic',
        benchmarkSummary: {
          ...makeTrialResult({ modelId: 'x' }).benchmarkSummary,
          overall: {
            ...makeTrialResult({ modelId: 'x' }).benchmarkSummary.overall,
            averageDeltaScore100: 2.5,
            withinFivePointsRate: 0.92,
            averageDurationMs: 1200,
          },
        },
      }),
    ];

    const comparison = buildCrossModelComparison('e2e-suite', results);
    expect(comparison.rankings.length).toBe(2);
    expect(comparison.bestOverall).toBeDefined();
    expect(comparison.bestAccuracy).toBe('claude-sonnet');
    expect(comparison.totalRecords).toBe(50);
  });

  it('formats a readable markdown comparison table', () => {
    const results: ModelTrialResult[] = [
      makeTrialResult({ modelId: 'model-a', modelName: 'Model A', provider: 'provider-1' }),
      makeTrialResult({ modelId: 'model-b', modelName: 'Model B', provider: 'provider-2' }),
    ];

    const comparison = buildCrossModelComparison('test-suite', results);
    const table = formatComparisonTable(comparison);

    expect(table).toContain('Cross-Model Comparison');
    expect(table).toContain('Model A');
    expect(table).toContain('Model B');
    expect(table).toContain('Best overall');
    expect(table).toContain('| Rank |');
  });
});
