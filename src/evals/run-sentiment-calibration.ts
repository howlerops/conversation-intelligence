import calibrationFixtures from '../../fixtures/sentiment-calibration.support.json';
import {
  deriveSentimentScore,
  sentimentCalibrationFixturesSchema,
} from '../sentiment/scoring';

export interface SentimentCalibrationResult {
  passed: boolean;
  name: string;
  category: string;
  reviewedBy: string;
  expectedScore100: number;
  actualScore100: number;
  expectedScore5: number;
  actualScore5: number;
  toleranceScore100: number;
  toleranceScore5: number;
  deltaScore100: number;
  deltaScore5: number;
}

export interface SentimentCalibrationSummary {
  total: number;
  passed: number;
  byScore5: Record<string, number>;
  byCategory: Record<string, number>;
  maxDeltaScore100: number;
  maxDeltaScore5: number;
  averageDeltaScore100: number;
  averageDeltaScore5: number;
}

export function runSentimentCalibration(): SentimentCalibrationResult[] {
  const fixtures = sentimentCalibrationFixturesSchema.parse(calibrationFixtures);

  return fixtures.map((fixture) => {
    const derived = deriveSentimentScore(fixture.sentiment);
    const deltaScore100 = Math.abs(derived.score100 - fixture.expected.score100);
    const deltaScore5 = Math.abs(derived.score5 - fixture.expected.score5);
    return {
      passed: deltaScore100 <= fixture.expected.score100Tolerance && deltaScore5 <= fixture.expected.score5Tolerance,
      name: fixture.name,
      category: fixture.category ?? 'uncategorized',
      reviewedBy: fixture.reviewedBy ?? 'unreviewed',
      expectedScore100: fixture.expected.score100,
      actualScore100: derived.score100,
      expectedScore5: fixture.expected.score5,
      actualScore5: derived.score5,
      toleranceScore100: fixture.expected.score100Tolerance,
      toleranceScore5: fixture.expected.score5Tolerance,
      deltaScore100,
      deltaScore5,
    };
  });
}

export function summarizeSentimentCalibration(
  results: SentimentCalibrationResult[],
): SentimentCalibrationSummary {
  const summary = results.reduce<SentimentCalibrationSummary>((summary, result) => {
    summary.total += 1;
    if (result.passed) {
      summary.passed += 1;
    }
    summary.byScore5[String(result.actualScore5)] = (summary.byScore5[String(result.actualScore5)] ?? 0) + 1;
    summary.byCategory[result.category] = (summary.byCategory[result.category] ?? 0) + 1;
    summary.maxDeltaScore100 = Math.max(summary.maxDeltaScore100, result.deltaScore100);
    summary.maxDeltaScore5 = Math.max(summary.maxDeltaScore5, result.deltaScore5);
    summary.averageDeltaScore100 += result.deltaScore100;
    summary.averageDeltaScore5 += result.deltaScore5;
    return summary;
  }, {
    total: 0,
    passed: 0,
    byScore5: {},
    byCategory: {},
    maxDeltaScore100: 0,
    maxDeltaScore5: 0,
    averageDeltaScore100: 0,
    averageDeltaScore5: 0,
  });

  if (summary.total > 0) {
    summary.averageDeltaScore100 /= summary.total;
    summary.averageDeltaScore5 /= summary.total;
  }

  return summary;
}
