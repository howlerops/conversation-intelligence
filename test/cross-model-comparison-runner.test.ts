import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';
import {
  rankModels,
  buildCrossModelComparison,
  formatComparisonTable,
  ModelTrialResult,
  modelTrialResultSchema,
} from '../src/validation/cross-model-comparison';
import { E2eBenchmarkSummary } from '../src/validation/e2e-benchmark';

const modelConfigSchema = z.object({
  modelId: z.string().min(1),
  modelName: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  apiKey: z.string().optional(),
  apiBase: z.string().optional(),
});

function makeResult(overrides: Partial<ModelTrialResult> & { modelId: string }): ModelTrialResult {
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

  return modelTrialResultSchema.parse({
    modelName: overrides.modelId,
    provider: 'test',
    benchmarkSummary: summary,
    runAt: new Date().toISOString(),
    durationMs: 30000,
    ...overrides,
  });
}

describe('cross-model comparison runner', () => {
  it('validates the sample model configs file', () => {
    const raw = JSON.parse(readFileSync(resolve(__dirname, '..', 'fixtures/benchmarks/model-configs-sample.json'), 'utf8'));
    const configs = z.array(modelConfigSchema).parse(raw);
    expect(configs.length).toBe(3);
    expect(configs[0].modelId).toBe('gpt-4o');
    expect(configs[1].provider).toBe('anthropic');
  });

  it('ranks 3 models correctly by composite score', () => {
    const results: ModelTrialResult[] = [
      makeResult({
        modelId: 'accurate',
        modelName: 'Accurate Model',
        benchmarkSummary: {
          ...makeResult({ modelId: 'x' }).benchmarkSummary,
          overall: {
            ...makeResult({ modelId: 'x' }).benchmarkSummary.overall,
            averageDeltaScore100: 1.5,
            withinFivePointsRate: 0.95,
            exactScore5MatchRate: 0.92,
          },
        },
      }),
      makeResult({
        modelId: 'fast',
        modelName: 'Fast Model',
        benchmarkSummary: {
          ...makeResult({ modelId: 'x' }).benchmarkSummary,
          overall: {
            ...makeResult({ modelId: 'x' }).benchmarkSummary.overall,
            averageDeltaScore100: 7.0,
            withinFivePointsRate: 0.60,
            averageDurationMs: 200,
          },
        },
      }),
      makeResult({
        modelId: 'balanced',
        modelName: 'Balanced Model',
        benchmarkSummary: {
          ...makeResult({ modelId: 'x' }).benchmarkSummary,
          overall: {
            ...makeResult({ modelId: 'x' }).benchmarkSummary.overall,
            averageDeltaScore100: 3.0,
            withinFivePointsRate: 0.88,
            averageDurationMs: 600,
          },
        },
      }),
    ];

    const comparison = buildCrossModelComparison('test-suite', results);
    expect(comparison.rankings[0].modelId).toBe('accurate');
    expect(comparison.bestAccuracy).toBe('accurate');
    expect(comparison.bestSpeed).toBe('fast');
  });

  it('generates valid markdown table with all model names', () => {
    const results = [
      makeResult({ modelId: 'model-a', modelName: 'Model Alpha' }),
      makeResult({ modelId: 'model-b', modelName: 'Model Beta' }),
    ];

    const comparison = buildCrossModelComparison('test', results);
    const table = formatComparisonTable(comparison);

    expect(table).toContain('Model Alpha');
    expect(table).toContain('Model Beta');
    expect(table).toContain('| Rank |');
    expect(table).toContain('Best overall');
  });

  it('handles single model without errors', () => {
    const results = [makeResult({ modelId: 'solo', modelName: 'Solo Model' })];
    const comparison = buildCrossModelComparison('single', results);

    expect(comparison.rankings.length).toBe(1);
    expect(comparison.rankings[0].rank).toBe(1);
    expect(comparison.bestOverall).toBe('solo');
    expect(comparison.bestAccuracy).toBe('solo');
    expect(comparison.bestSpeed).toBe('solo');
  });
});
