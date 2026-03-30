import { describe, expect, it } from 'vitest';
import { aggregateE2eTrialExecutions } from '../src';

function buildLoopReport(
  averageDeltaScore100: number,
  withinFivePointsRate: number,
  exactScore5MatchRate: number,
  averageDurationMs: number,
  failures: string[],
) {
  return {
    generatedAt: '2026-03-29T00:00:00.000Z',
    suitePath: '/tmp/suite.json',
    reviewedDatasetPath: null,
    calibrationSource: 'benchmark' as const,
    baseline: {
      summary: buildSummary(averageDeltaScore100, withinFivePointsRate, exactScore5MatchRate, averageDurationMs),
      metadataPath: '/tmp/baseline/metadata.json',
      recordsPath: '/tmp/baseline/records.jsonl',
      gates: {
        metExpectations: failures.length === 0,
        failures,
      },
      worstRecords: [],
    },
    calibrated: {
      summary: buildSummary(averageDeltaScore100, withinFivePointsRate, exactScore5MatchRate, averageDurationMs),
      metadataPath: '/tmp/calibrated/metadata.json',
      recordsPath: '/tmp/calibrated/records.jsonl',
      gates: {
        metExpectations: failures.length === 0,
        failures,
      },
      worstRecords: [],
    },
    recommendedCalibrationPath: '/tmp/recommended.json',
    recommendedCalibrationSource: 'benchmark' as const,
  };
}

function buildSummary(
  averageDeltaScore100: number,
  withinFivePointsRate: number,
  exactScore5MatchRate: number,
  averageDurationMs: number,
) {
  const overall = {
    total: 14,
    completed: 14,
    failed: 0,
    compared: 14,
    reviewCount: 0,
    uncertainCount: 0,
    averageDurationMs,
    p95DurationMs: averageDurationMs,
    averageDeltaScore100,
    averageDeltaScore5: 0.25,
    exactScore5MatchRate,
    withinFivePointsRate,
    reviewStateMatchRate: 1,
  };

  return {
    totalRecords: 14,
    bySource: {},
    byEngagementType: {},
    byQueue: {},
    byTranscriptLengthBucket: {},
    overall,
  };
}

describe('e2e trial matrix aggregation', () => {
  it('ranks best/median/worst completed trials and summarizes distributions', () => {
    const summary = aggregateE2eTrialExecutions([
      {
        trialId: '001',
        status: 'COMPLETED',
        outputDir: '/tmp/001',
        reportPath: '/tmp/001/loop-report.json',
        report: buildLoopReport(3.8, 0.72, 0.86, 16000, ['withinFivePointsRate gate']),
      },
      {
        trialId: '002',
        status: 'COMPLETED',
        outputDir: '/tmp/002',
        reportPath: '/tmp/002/loop-report.json',
        report: buildLoopReport(6.1, 0.57, 0.71, 15000, ['averageDeltaScore100 gate', 'withinFivePointsRate gate']),
      },
      {
        trialId: '003',
        status: 'COMPLETED',
        outputDir: '/tmp/003',
        reportPath: '/tmp/003/loop-report.json',
        report: buildLoopReport(4.8, 0.71, 0.86, 15500, ['withinFivePointsRate gate']),
      },
      {
        trialId: '004',
        status: 'FAILED',
        outputDir: '/tmp/004',
        errorMessage: 'child failed',
      },
    ]);

    expect(summary.totalTrials).toBe(4);
    expect(summary.completedTrials).toBe(3);
    expect(summary.failedTrials).toBe(1);
    expect(summary.bestTrialId).toBe('001');
    expect(summary.medianTrialId).toBe('003');
    expect(summary.worstTrialId).toBe('002');
    expect(summary.calibrated?.averageDeltaScore100).toEqual({
      min: 3.8,
      median: 4.8,
      mean: 4.9,
      max: 6.1,
    });
    expect(summary.calibrated?.withinFivePointsRate).toEqual({
      min: 0.57,
      median: 0.71,
      mean: 0.6667,
      max: 0.72,
    });
    expect(summary.calibrated?.passRate).toBe(0);
  });
});
