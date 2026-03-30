import { describe, expect, it } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  captureBaseline,
  compareToBaseline,
  formatRegressionReport,
  loadBaseline,
} from '../src/validation/regression-baseline';
import { E2eBenchmarkSummary } from '../src/validation/e2e-benchmark';

function makeSummary(overrides: Partial<E2eBenchmarkSummary['overall']> = {}): E2eBenchmarkSummary {
  const overall = {
    total: 100,
    completed: 95,
    failed: 5,
    compared: 90,
    reviewCount: 10,
    uncertainCount: 5,
    averageDurationMs: 800,
    p95DurationMs: 2000,
    averageDeltaScore100: 3.5,
    averageDeltaScore5: 0.7,
    exactScore5MatchRate: 0.85,
    withinFivePointsRate: 0.88,
    reviewStateMatchRate: 0.90,
    ...overrides,
  };

  return {
    totalRecords: overall.total,
    bySource: {},
    byEngagementType: {},
    byQueue: {},
    byTranscriptLengthBucket: {},
    overall,
  } as E2eBenchmarkSummary;
}

describe('regression baseline', () => {
  it('captures and loads a baseline from a benchmark summary', async () => {
    const summary = makeSummary();
    const path = join(tmpdir(), `regression-test-${randomUUID()}.json`);

    const baseline = await captureBaseline('smoke', summary, path, { model: 'gpt-4o', packVersion: 'v1.0' });
    expect(baseline.suiteId).toBe('smoke');
    expect(baseline.model).toBe('gpt-4o');
    expect(baseline.summary.overall.averageDeltaScore100).toBe(3.5);

    const loaded = await loadBaseline(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.suiteId).toBe('smoke');
  });

  it('returns null for non-existent baseline', async () => {
    const loaded = await loadBaseline('/tmp/nonexistent-baseline.json');
    expect(loaded).toBeNull();
  });

  it('detects no regressions when metrics are stable', () => {
    const baseline = {
      capturedAt: '2026-03-01T00:00:00.000Z',
      suiteId: 'smoke',
      summary: makeSummary(),
    };

    const current = makeSummary({ averageDeltaScore100: 3.6 });
    const comparison = compareToBaseline('smoke', current, baseline);

    expect(comparison.overallVerdict).toBe('PASS');
    expect(comparison.regressionCount).toBe(0);
  });

  it('detects regression when accuracy degrades beyond threshold', () => {
    const baseline = {
      capturedAt: '2026-03-01T00:00:00.000Z',
      suiteId: 'smoke',
      summary: makeSummary({ averageDeltaScore100: 3.0 }),
    };

    const current = makeSummary({ averageDeltaScore100: 7.0 });
    const comparison = compareToBaseline('smoke', current, baseline);

    expect(comparison.overallVerdict).toBe('REGRESSION_DETECTED');
    expect(comparison.regressionCount).toBeGreaterThan(0);

    const deltaMetric = comparison.metrics.find((m) => m.metric === 'overall.averageDeltaScore100');
    expect(deltaMetric).toBeDefined();
    expect(deltaMetric!.regressed).toBe(true);
    expect(deltaMetric!.direction).toBe('regressed');
  });

  it('detects regression when match rates drop', () => {
    const baseline = {
      capturedAt: '2026-03-01T00:00:00.000Z',
      suiteId: 'smoke',
      summary: makeSummary({ withinFivePointsRate: 0.90 }),
    };

    const current = makeSummary({ withinFivePointsRate: 0.70 });
    const comparison = compareToBaseline('smoke', current, baseline);

    expect(comparison.overallVerdict).toBe('REGRESSION_DETECTED');
    const metric = comparison.metrics.find((m) => m.metric === 'overall.withinFivePointsRate');
    expect(metric!.regressed).toBe(true);
  });

  it('detects improvement when metrics get better', () => {
    const baseline = {
      capturedAt: '2026-03-01T00:00:00.000Z',
      suiteId: 'smoke',
      summary: makeSummary({ averageDeltaScore100: 5.0 }),
    };

    const current = makeSummary({ averageDeltaScore100: 2.0 });
    const comparison = compareToBaseline('smoke', current, baseline);

    expect(comparison.overallVerdict).toBe('PASS');
    expect(comparison.improvementCount).toBeGreaterThan(0);

    const metric = comparison.metrics.find((m) => m.metric === 'overall.averageDeltaScore100');
    expect(metric!.direction).toBe('improved');
  });

  it('formats a human-readable regression report', () => {
    const baseline = {
      capturedAt: '2026-03-01T00:00:00.000Z',
      suiteId: 'smoke',
      summary: makeSummary({ averageDeltaScore100: 3.0 }),
    };

    const current = makeSummary({ averageDeltaScore100: 6.0 });
    const comparison = compareToBaseline('smoke', current, baseline);
    const report = formatRegressionReport(comparison);

    expect(report).toContain('REGRESSION_DETECTED');
    expect(report).toContain('overall.averageDeltaScore100');
    expect(report).toContain('[REGRESSION]');
  });
});
