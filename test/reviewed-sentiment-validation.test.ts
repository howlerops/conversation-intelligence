import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { gzipSync } from 'zlib';
import { describe, expect, it } from 'vitest';
import {
  recommendSentimentScoringConfigFromDataset,
  runReviewedSentimentValidation,
  summarizeReviewedSentimentValidation,
} from '../src';

describe('reviewed sentiment validation', () => {
  it('compares derived sentiment scores to analyst-reviewed outcomes', async () => {
    const results = await runReviewedSentimentValidation();
    expect(results.length).toBeGreaterThanOrEqual(20);
    expect(results.some((result) => result.analystCorrectionApplied)).toBe(true);

    const summary = summarizeReviewedSentimentValidation(results);
    expect(summary.total).toBe(results.length);
    expect(summary.maxDeltaScore100).toBeLessThanOrEqual(5);
    expect(summary.maxDeltaScore5).toBeLessThanOrEqual(1);
    expect(summary.withinFivePointsScore100).toBe(results.length);
    expect(summary.byReviewState.VERIFIED).toBeGreaterThan(0);
    expect(summary.byReviewState.NEEDS_REVIEW).toBeGreaterThan(0);
    expect(summary.byEngagementType.CALL.total).toBeGreaterThan(0);
    expect(summary.byEngagementType.EMAIL.total).toBeGreaterThan(0);
    expect(summary.byEngagementType.TICKET.total).toBeGreaterThan(0);
  });

  it('loads reviewed sentiment samples from a directory tree and deduplicates repeated rows', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-reviewed-sentiment-'));
    try {
      const nestedDir = join(rootDir, 'tenant_acme');
      await mkdir(nestedDir, { recursive: true });
      const sample = {
        runId: 'run-dir-001',
        tenantId: 'tenant_acme',
        useCase: 'support',
        source: 'review_export',
        engagementType: 'CALL',
        name: 'Directory Sample',
        reviewedAt: '2026-03-28T00:00:00.000Z',
        model: {
          polarity: 'NEGATIVE',
          intensity: 0.5,
          confidence: 0.8,
          rationale: 'Directory sample.',
        },
        analyst: {
          score100: 25,
          score5: 2,
          reviewState: 'VERIFIED',
          correctionApplied: false,
          reviewedAt: '2026-03-28T00:00:00.000Z',
        },
      };

      await writeFile(join(rootDir, 'support.json'), JSON.stringify([sample], null, 2));
      await writeFile(join(rootDir, 'summary.json'), JSON.stringify({ pipelineCount: 1 }, null, 2));
      await writeFile(join(nestedDir, 'support.jsonl'), `${JSON.stringify(sample)}\n`);

      const results = await runReviewedSentimentValidation(rootDir);
      expect(results).toHaveLength(1);
      expect(results[0]?.engagementType).toBe('CALL');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('loads gzip-compressed reviewed sentiment datasets', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-reviewed-sentiment-gzip-'));
    try {
      const sample = {
        runId: 'run-gzip-001',
        tenantId: 'tenant_acme',
        useCase: 'support',
        source: 'review_export',
        engagementType: 'EMAIL',
        name: 'Gzip Sample',
        reviewedAt: '2026-03-28T00:00:00.000Z',
        model: {
          polarity: 'NEGATIVE',
          intensity: 0.4,
          confidence: 0.8,
          rationale: 'Compressed sample.',
        },
        analyst: {
          score100: 33,
          score5: 2,
          reviewState: 'VERIFIED',
          correctionApplied: false,
          reviewedAt: '2026-03-28T00:00:00.000Z',
        },
      };

      await writeFile(
        join(rootDir, 'support.jsonl.gz'),
        gzipSync(`${JSON.stringify(sample)}\n`),
      );

      const results = await runReviewedSentimentValidation(rootDir);
      expect(results).toHaveLength(1);
      expect(results[0]?.engagementType).toBe('EMAIL');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('accepts reviewed export trees as reviewed sentiment datasets', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-reviewed-export-validation-'));
    try {
      await writeFile(join(rootDir, 'support.jsonl'), `${JSON.stringify({
        runId: 'reviewed-export-001',
        tenantId: 'tenant_acme',
        useCase: 'support',
        engagementType: 'TICKET',
        queue: 'support_async',
        transcriptTurnCount: 2,
        transcriptCharacterCount: 64,
        transcriptLengthBucket: 'SHORT',
        createdAt: '2026-03-28T00:00:00.000Z',
        updatedAt: '2026-03-28T00:01:00.000Z',
        model: {
          polarity: 'NEGATIVE',
          intensity: 0.45,
          confidence: 0.85,
          rationale: 'Reviewed export model sentiment.',
          score: {
            method: 'derived_v1',
            score100: 28,
            score5: 2,
          },
        },
        review: {
          state: 'NEEDS_REVIEW',
          analystSentiment: {
            score100: 30,
            score5: 2,
            correctionApplied: true,
            reviewedAt: '2026-03-28T00:02:00.000Z',
            reviewedById: 'analyst_1',
            reviewedByType: 'USER',
          },
          reasons: ['Manual spot check.'],
        },
      })}\n`);

      const results = await runReviewedSentimentValidation(rootDir);
      expect(results).toHaveLength(1);
      expect(results[0]?.engagementType).toBe('TICKET');
      expect(results[0]?.analystCorrectionApplied).toBe(true);
      expect(results[0]?.deltaScore100).toBeLessThanOrEqual(5);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('can apply recommended calibration during reviewed validation', async () => {
    const recommendation = await recommendSentimentScoringConfigFromDataset(undefined, {
      minimumSampleSize: 10,
      minimumSampleSizePerEngagementType: 5,
    });

    const rootDir = await mkdtemp(join(tmpdir(), 'ci-reviewed-sentiment-calibrated-'));
    try {
      const calibrationPath = join(rootDir, 'sentiment-scoring.json');
      await writeFile(calibrationPath, JSON.stringify(recommendation.recommendedConfig, null, 2));

      const baselineResults = await runReviewedSentimentValidation();
      const calibratedResults = await runReviewedSentimentValidation(undefined, calibrationPath);
      const baselineSummary = summarizeReviewedSentimentValidation(baselineResults);
      const calibratedSummary = summarizeReviewedSentimentValidation(calibratedResults);

      expect(calibratedSummary.total).toBe(baselineSummary.total);
      expect(calibratedSummary.averageDeltaScore100).toBeLessThan(baselineSummary.averageDeltaScore100);
      expect(calibratedSummary.byEngagementType.TICKET.averageDeltaScore100)
        .toBeLessThan(baselineSummary.byEngagementType.TICKET.averageDeltaScore100);
      expect(calibratedSummary.byEngagementType.EMAIL.averageDeltaScore100)
        .toBeLessThanOrEqual(baselineSummary.byEngagementType.EMAIL.averageDeltaScore100);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
