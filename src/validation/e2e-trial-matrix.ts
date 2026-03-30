import { z } from 'zod';
import {
  e2eBenchmarkSummarySchema,
} from './e2e-benchmark';

const gateSummarySchema = z.object({
  metExpectations: z.boolean(),
  failures: z.array(z.string()),
});

const worstRecordSchema = z.object({
  recordId: z.string().min(1),
  engagementType: z.string().min(1),
  queue: z.string().min(1).optional(),
  deltaScore100: z.number().optional(),
  deltaScore5: z.number().optional(),
  status: z.string().min(1),
  errorMessage: z.string().optional(),
});

const loopPhaseSchema = z.object({
  summary: e2eBenchmarkSummarySchema,
  metadataPath: z.string().min(1),
  recordsPath: z.string().min(1),
  gates: gateSummarySchema,
  worstRecords: z.array(worstRecordSchema).default([]),
});

export const e2eImprovementLoopReportSchema = z.object({
  generatedAt: z.string().min(1),
  suitePath: z.string().min(1),
  reviewedDatasetPath: z.string().nullable(),
  calibrationSource: z.enum(['auto', 'reviewed', 'benchmark']),
  baseline: loopPhaseSchema,
  calibrated: loopPhaseSchema.nullable(),
  recommendedCalibrationPath: z.string().nullable(),
  recommendedCalibrationSource: z.enum(['reviewed', 'benchmark']).nullable(),
  benchmarkRecommendation: z.unknown().optional(),
  reviewedRecommendation: z.unknown().nullable().optional(),
});

export type E2eImprovementLoopReport = z.infer<typeof e2eImprovementLoopReportSchema>;

export const e2eTrialExecutionSchema = z.object({
  trialId: z.string().min(1),
  status: z.enum(['COMPLETED', 'FAILED']),
  outputDir: z.string().min(1),
  reportPath: z.string().optional(),
  report: e2eImprovementLoopReportSchema.optional(),
  errorMessage: z.string().optional(),
});

export type E2eTrialExecution = z.infer<typeof e2eTrialExecutionSchema>;

const metricDistributionSchema = z.object({
  min: z.number(),
  median: z.number(),
  mean: z.number(),
  max: z.number(),
});

const phaseAggregateSchema = z.object({
  totalTrials: z.number().int().min(0),
  passedGateCount: z.number().int().min(0),
  passRate: z.number().min(0).max(1),
  averageDeltaScore100: metricDistributionSchema.optional(),
  withinFivePointsRate: metricDistributionSchema.optional(),
  exactScore5MatchRate: metricDistributionSchema.optional(),
  averageDurationMs: metricDistributionSchema,
});

export type E2eTrialPhaseAggregate = z.infer<typeof phaseAggregateSchema>;

export const e2eTrialMatrixSummarySchema = z.object({
  totalTrials: z.number().int().min(0),
  completedTrials: z.number().int().min(0),
  failedTrials: z.number().int().min(0),
  bestTrialId: z.string().min(1).optional(),
  medianTrialId: z.string().min(1).optional(),
  worstTrialId: z.string().min(1).optional(),
  baseline: phaseAggregateSchema.optional(),
  calibrated: phaseAggregateSchema.optional(),
});

export type E2eTrialMatrixSummary = z.infer<typeof e2eTrialMatrixSummarySchema>;

export function aggregateE2eTrialExecutions(
  executionsInput: unknown,
): E2eTrialMatrixSummary {
  const executions = z.array(e2eTrialExecutionSchema).parse(executionsInput);
  const completed = executions.filter((execution) => execution.status === 'COMPLETED' && execution.report);
  const ranked = [...completed].sort(compareTrials);

  return e2eTrialMatrixSummarySchema.parse({
    totalTrials: executions.length,
    completedTrials: completed.length,
    failedTrials: executions.filter((execution) => execution.status === 'FAILED').length,
    bestTrialId: ranked[0]?.trialId,
    medianTrialId: ranked.length === 0 ? undefined : ranked[Math.floor(ranked.length / 2)]?.trialId,
    worstTrialId: ranked.at(-1)?.trialId,
    baseline: completed.length === 0 ? undefined : aggregatePhase(completed.map((execution) => execution.report!.baseline)),
    calibrated: completed.some((execution) => execution.report?.calibrated)
      ? aggregatePhase(completed.flatMap((execution) => execution.report?.calibrated ? [execution.report.calibrated] : []))
      : undefined,
  });
}

function compareTrials(left: E2eTrialExecution, right: E2eTrialExecution): number {
  const leftKey = buildTrialRankKey(left.report!);
  const rightKey = buildTrialRankKey(right.report!);

  for (let index = 0; index < leftKey.length; index += 1) {
    if (leftKey[index] === rightKey[index]) {
      continue;
    }
    return leftKey[index]! < rightKey[index]! ? -1 : 1;
  }

  return left.trialId.localeCompare(right.trialId);
}

function buildTrialRankKey(report: E2eImprovementLoopReport): number[] {
  const phase = report.calibrated ?? report.baseline;
  const overall = phase.summary.overall;

  return [
    phase.gates.failures.length,
    overall.averageDeltaScore100 ?? Number.POSITIVE_INFINITY,
    -(overall.withinFivePointsRate ?? 0),
    -(overall.exactScore5MatchRate ?? 0),
    overall.averageDurationMs,
  ];
}

function aggregatePhase(
  phases: E2eImprovementLoopReport['baseline'][],
): E2eTrialPhaseAggregate {
  return phaseAggregateSchema.parse({
    totalTrials: phases.length,
    passedGateCount: phases.filter((phase) => phase.gates.metExpectations).length,
    passRate: phases.length === 0 ? 0 : Number((phases.filter((phase) => phase.gates.metExpectations).length / phases.length).toFixed(4)),
    averageDeltaScore100: summarizeOptionalMetric(phases.map((phase) => phase.summary.overall.averageDeltaScore100)),
    withinFivePointsRate: summarizeOptionalMetric(phases.map((phase) => phase.summary.overall.withinFivePointsRate)),
    exactScore5MatchRate: summarizeOptionalMetric(phases.map((phase) => phase.summary.overall.exactScore5MatchRate)),
    averageDurationMs: summarizeMetric(phases.map((phase) => phase.summary.overall.averageDurationMs)),
  });
}

function summarizeOptionalMetric(values: Array<number | undefined>): z.infer<typeof metricDistributionSchema> | undefined {
  const numeric = values.filter((value): value is number => typeof value === 'number');
  return numeric.length === 0 ? undefined : summarizeMetric(numeric);
}

function summarizeMetric(values: number[]): z.infer<typeof metricDistributionSchema> {
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);

  return metricDistributionSchema.parse({
    min: sorted[0] ?? 0,
    median: Number(resolveMedian(sorted).toFixed(4)),
    mean: Number((sum / Math.max(sorted.length, 1)).toFixed(4)),
    max: sorted.at(-1) ?? 0,
  });
}

function resolveMedian(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) {
    return values[middle] ?? 0;
  }
  return ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2;
}
