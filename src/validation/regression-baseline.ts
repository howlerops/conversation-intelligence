import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { z } from 'zod';
import { E2eBenchmarkSummary, e2eBenchmarkSummarySchema } from './e2e-benchmark';

// ---------------------------------------------------------------------------
// Baseline snapshot — captured after a known-good benchmark run.
// ---------------------------------------------------------------------------

export const regressionBaselineSchema = z.object({
  capturedAt: z.string().min(1),
  suiteId: z.string().min(1),
  model: z.string().min(1).optional(),
  packVersion: z.string().min(1).optional(),
  summary: e2eBenchmarkSummarySchema,
});

export type RegressionBaseline = z.infer<typeof regressionBaselineSchema>;

// ---------------------------------------------------------------------------
// Regression comparison — diff between current run and baseline.
// ---------------------------------------------------------------------------

const metricComparisonSchema = z.object({
  metric: z.string().min(1),
  baseline: z.number(),
  current: z.number(),
  delta: z.number(),
  direction: z.enum(['improved', 'regressed', 'stable']),
  regressed: z.boolean(),
});

export type MetricComparison = z.infer<typeof metricComparisonSchema>;

export const regressionComparisonSchema = z.object({
  suiteId: z.string().min(1),
  comparedAt: z.string().min(1),
  baselineCapturedAt: z.string().min(1),
  metrics: z.array(metricComparisonSchema),
  regressionCount: z.number().int().min(0),
  improvementCount: z.number().int().min(0),
  overallVerdict: z.enum(['PASS', 'REGRESSION_DETECTED']),
});

export type RegressionComparison = z.infer<typeof regressionComparisonSchema>;

// ---------------------------------------------------------------------------
// Thresholds — how much drift counts as a regression.
// ---------------------------------------------------------------------------

export interface RegressionThresholds {
  maxAccuracyDegradation?: number;
  maxLatencyIncrease?: number;
  maxMatchRateDrop?: number;
}

const DEFAULT_THRESHOLDS: Required<RegressionThresholds> = {
  maxAccuracyDegradation: 2.0,
  maxLatencyIncrease: 0.25,
  maxMatchRateDrop: 0.05,
};

// ---------------------------------------------------------------------------
// Capture a baseline from a benchmark summary.
// ---------------------------------------------------------------------------

export async function captureBaseline(
  suiteId: string,
  summary: E2eBenchmarkSummary,
  outputPath: string,
  options?: { model?: string; packVersion?: string },
): Promise<RegressionBaseline> {
  const baseline = regressionBaselineSchema.parse({
    capturedAt: new Date().toISOString(),
    suiteId,
    model: options?.model,
    packVersion: options?.packVersion,
    summary,
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(baseline, null, 2));
  return baseline;
}

// ---------------------------------------------------------------------------
// Load a previously captured baseline.
// ---------------------------------------------------------------------------

export async function loadBaseline(path: string): Promise<RegressionBaseline | null> {
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf8');
  return regressionBaselineSchema.parse(JSON.parse(raw));
}

// ---------------------------------------------------------------------------
// Compare current summary against a baseline.
// ---------------------------------------------------------------------------

export function compareToBaseline(
  suiteId: string,
  current: E2eBenchmarkSummary,
  baseline: RegressionBaseline,
  thresholds: RegressionThresholds = {},
): RegressionComparison {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const metrics: MetricComparison[] = [];

  const b = baseline.summary.overall;
  const c = current.overall;

  addAccuracyMetric(metrics, 'overall.averageDeltaScore100', b.averageDeltaScore100, c.averageDeltaScore100, t.maxAccuracyDegradation, true);
  addAccuracyMetric(metrics, 'overall.averageDeltaScore5', b.averageDeltaScore5, c.averageDeltaScore5, t.maxAccuracyDegradation / 5, true);
  addRateMetric(metrics, 'overall.exactScore5MatchRate', b.exactScore5MatchRate, c.exactScore5MatchRate, t.maxMatchRateDrop);
  addRateMetric(metrics, 'overall.withinFivePointsRate', b.withinFivePointsRate, c.withinFivePointsRate, t.maxMatchRateDrop);
  addRateMetric(metrics, 'overall.reviewStateMatchRate', b.reviewStateMatchRate, c.reviewStateMatchRate, t.maxMatchRateDrop);
  addLatencyMetric(metrics, 'overall.averageDurationMs', b.averageDurationMs, c.averageDurationMs, t.maxLatencyIncrease);
  addLatencyMetric(metrics, 'overall.p95DurationMs', b.p95DurationMs, c.p95DurationMs, t.maxLatencyIncrease);

  for (const engagementType of Object.keys({ ...baseline.summary.byEngagementType, ...current.byEngagementType })) {
    const bEng = baseline.summary.byEngagementType[engagementType];
    const cEng = current.byEngagementType[engagementType];
    if (!bEng || !cEng) continue;

    addAccuracyMetric(metrics, `${engagementType}.averageDeltaScore100`, bEng.averageDeltaScore100, cEng.averageDeltaScore100, t.maxAccuracyDegradation, true);
    addRateMetric(metrics, `${engagementType}.withinFivePointsRate`, bEng.withinFivePointsRate, cEng.withinFivePointsRate, t.maxMatchRateDrop);
  }

  const regressionCount = metrics.filter((m) => m.regressed).length;
  const improvementCount = metrics.filter((m) => m.direction === 'improved').length;

  return regressionComparisonSchema.parse({
    suiteId,
    comparedAt: new Date().toISOString(),
    baselineCapturedAt: baseline.capturedAt,
    metrics,
    regressionCount,
    improvementCount,
    overallVerdict: regressionCount > 0 ? 'REGRESSION_DETECTED' : 'PASS',
  });
}

// ---------------------------------------------------------------------------
// Report formatting.
// ---------------------------------------------------------------------------

export function formatRegressionReport(comparison: RegressionComparison): string {
  const lines: string[] = [
    `Regression Report — ${comparison.suiteId}`,
    `Compared at: ${comparison.comparedAt}`,
    `Baseline from: ${comparison.baselineCapturedAt}`,
    `Verdict: ${comparison.overallVerdict}`,
    `Regressions: ${comparison.regressionCount} | Improvements: ${comparison.improvementCount}`,
    '',
  ];

  for (const m of comparison.metrics) {
    const arrow = m.direction === 'improved' ? '+' : m.direction === 'regressed' ? '!' : '=';
    const flag = m.regressed ? ' [REGRESSION]' : '';
    lines.push(`  ${arrow} ${m.metric}: ${m.baseline.toFixed(3)} → ${m.current.toFixed(3)} (delta: ${m.delta > 0 ? '+' : ''}${m.delta.toFixed(3)})${flag}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addAccuracyMetric(
  metrics: MetricComparison[],
  name: string,
  baseline: number | undefined,
  current: number | undefined,
  threshold: number,
  lowerIsBetter: boolean,
) {
  if (baseline === undefined || current === undefined) return;
  const delta = current - baseline;
  const regressed = lowerIsBetter ? delta > threshold : delta < -threshold;
  const improved = lowerIsBetter ? delta < -threshold / 2 : delta > threshold / 2;
  metrics.push(metricComparisonSchema.parse({
    metric: name,
    baseline,
    current,
    delta: Number(delta.toFixed(4)),
    direction: regressed ? 'regressed' : improved ? 'improved' : 'stable',
    regressed,
  }));
}

function addRateMetric(
  metrics: MetricComparison[],
  name: string,
  baseline: number | undefined,
  current: number | undefined,
  threshold: number,
) {
  if (baseline === undefined || current === undefined) return;
  const delta = current - baseline;
  const regressed = delta < -threshold;
  const improved = delta > threshold / 2;
  metrics.push(metricComparisonSchema.parse({
    metric: name,
    baseline,
    current,
    delta: Number(delta.toFixed(4)),
    direction: regressed ? 'regressed' : improved ? 'improved' : 'stable',
    regressed,
  }));
}

function addLatencyMetric(
  metrics: MetricComparison[],
  name: string,
  baseline: number,
  current: number,
  maxFractionalIncrease: number,
) {
  if (baseline === 0) return;
  const delta = current - baseline;
  const fractionIncrease = delta / baseline;
  const regressed = fractionIncrease > maxFractionalIncrease;
  const improved = fractionIncrease < -maxFractionalIncrease / 2;
  metrics.push(metricComparisonSchema.parse({
    metric: name,
    baseline,
    current,
    delta: Number(delta.toFixed(2)),
    direction: regressed ? 'regressed' : improved ? 'improved' : 'stable',
    regressed,
  }));
}
