import { Dirent } from 'fs';
import { lstat, readdir, readFile } from 'fs/promises';
import { basename, resolve } from 'path';
import { ReviewedRunExportRecord, reviewedRunExportRecordSchema } from '../contracts';
import {
  ReviewedSentimentOutcomeSample,
  reviewedSentimentOutcomeSamplesSchema,
} from '../sentiment/scoring';
import {
  ReviewedSentimentValidationSummary,
  runReviewedSentimentValidationFromSamples,
  summarizeReviewedSentimentValidation,
} from '../evals/run-reviewed-sentiment-validation';

export interface PublicShadowComparisonMetrics {
  total: number;
  averageDeltaScore100: number;
  averageDeltaScore5: number;
  exactScore5MatchRate: number;
  withinFivePointsRate: number;
  correctedCount: number;
}

export interface PublicShadowEngagementComparison {
  engagementType: string;
  public?: PublicShadowComparisonMetrics;
  shadow?: PublicShadowComparisonMetrics;
  deltas: {
    averageDeltaScore100?: number;
    averageDeltaScore5?: number;
    exactScore5MatchRate?: number;
    withinFivePointsRate?: number;
  };
}

export interface PublicShadowComparisonResult {
  generatedAt: string;
  publicSourcePath: string;
  shadowSourcePath: string;
  publicSummary: PublicShadowComparisonMetrics;
  shadowSummary: PublicShadowComparisonMetrics;
  engagementComparisons: PublicShadowEngagementComparison[];
}

export async function comparePublicAndShadowValidation(input: {
  publicPath: string;
  shadowPath: string;
  clock?: () => Date;
}): Promise<PublicShadowComparisonResult> {
  const clock = input.clock ?? (() => new Date());
  const [publicSamples, shadowSamples] = await Promise.all([
    loadPublicReviewedSamples(input.publicPath),
    loadShadowReviewedSamples(input.shadowPath),
  ]);

  const publicSummary = summarizeReviewedSentimentValidation(runReviewedSentimentValidationFromSamples(publicSamples));
  const shadowSummary = summarizeReviewedSentimentValidation(runReviewedSentimentValidationFromSamples(shadowSamples));
  const engagementTypes = new Set<string>([
    ...Object.keys(publicSummary.byEngagementType),
    ...Object.keys(shadowSummary.byEngagementType),
  ]);

  return {
    generatedAt: clock().toISOString(),
    publicSourcePath: resolve(input.publicPath),
    shadowSourcePath: resolve(input.shadowPath),
    publicSummary: metricsFromSummary(publicSummary),
    shadowSummary: metricsFromSummary(shadowSummary),
    engagementComparisons: Array.from(engagementTypes)
      .sort((left, right) => left.localeCompare(right))
      .map((engagementType) => {
        const publicMetrics = metricsFromEngagementBucket(publicSummary.byEngagementType[engagementType]);
        const shadowMetrics = metricsFromEngagementBucket(shadowSummary.byEngagementType[engagementType]);

        return {
          engagementType,
          public: publicMetrics,
          shadow: shadowMetrics,
          deltas: {
            averageDeltaScore100: definedDifference(shadowMetrics?.averageDeltaScore100, publicMetrics?.averageDeltaScore100),
            averageDeltaScore5: definedDifference(shadowMetrics?.averageDeltaScore5, publicMetrics?.averageDeltaScore5),
            exactScore5MatchRate: definedDifference(shadowMetrics?.exactScore5MatchRate, publicMetrics?.exactScore5MatchRate),
            withinFivePointsRate: definedDifference(shadowMetrics?.withinFivePointsRate, publicMetrics?.withinFivePointsRate),
          },
        };
      }),
  };
}

async function loadPublicReviewedSamples(rootPath: string): Promise<ReviewedSentimentOutcomeSample[]> {
  const files = await collectFiles(resolve(rootPath), (entry, path) => entry.isFile() && basename(path) === 'reviewed-sentiment.jsonl');
  const samples: ReviewedSentimentOutcomeSample[] = [];

  for (const file of files) {
    samples.push(...await loadReviewedSentimentSamplesFromFile(file));
  }

  return samples;
}

async function loadShadowReviewedSamples(rootPath: string): Promise<ReviewedSentimentOutcomeSample[]> {
  const absolutePath = resolve(rootPath);
  const files = await collectFiles(absolutePath, (entry, path) => {
    if (!entry.isFile()) {
      return false;
    }
    if (path.includes('/snapshots/')) {
      return false;
    }
    return path.endsWith('.jsonl') || path.endsWith('.json');
  });
  const samples: ReviewedSentimentOutcomeSample[] = [];

  for (const file of files) {
    const loaded = await loadShadowSamplesFromFile(file);
    samples.push(...loaded);
  }

  return samples;
}

async function loadShadowSamplesFromFile(path: string): Promise<ReviewedSentimentOutcomeSample[]> {
  const directSamples = await tryLoadReviewedSentimentSamplesFromFile(path);
  if (directSamples) {
    return directSamples;
  }

  const records = await loadReviewedRunExportRecords(path);
  const samples: ReviewedSentimentOutcomeSample[] = [];
  for (const record of records) {
    const sample = sampleFromReviewedRunExportRecord(record);
    if (sample) {
      samples.push(sample);
    }
  }

  return samples;
}

async function loadReviewedSentimentSamplesFromFile(path: string): Promise<ReviewedSentimentOutcomeSample[]> {
  const loaded = await tryLoadReviewedSentimentSamplesFromFile(path);
  if (!loaded) {
    throw new Error(`File ${path} is not a reviewed sentiment sample dataset.`);
  }
  return loaded;
}

async function tryLoadReviewedSentimentSamplesFromFile(path: string): Promise<ReviewedSentimentOutcomeSample[] | null> {
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  try {
    if (trimmed.startsWith('[')) {
      return reviewedSentimentOutcomeSamplesSchema.parse(JSON.parse(trimmed));
    }
    return reviewedSentimentOutcomeSamplesSchema.parse(
      trimmed
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
  } catch {
    return null;
  }
}

async function loadReviewedRunExportRecords(path: string): Promise<ReviewedRunExportRecord[]> {
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith('[')) {
    return (JSON.parse(trimmed) as unknown[]).map((record) => reviewedRunExportRecordSchema.parse(record));
  }
  return trimmed
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => reviewedRunExportRecordSchema.parse(JSON.parse(line)));
}

function sampleFromReviewedRunExportRecord(record: ReviewedRunExportRecord): ReviewedSentimentOutcomeSample | null {
  if (!record.model || !record.review.analystSentiment) {
    return null;
  }

  return {
    runId: record.runId,
    tenantId: record.tenantId,
    useCase: record.useCase,
    source: 'review_export',
    engagementType: record.engagementType,
    sourceDataset: record.sourceDataset,
    datasetTrack: record.datasetTrack,
    name: record.runId,
    category: record.useCase,
    reviewedBy: record.review.analystSentiment.reviewedById,
    reviewedAt: record.review.analystSentiment.reviewedAt,
    model: {
      polarity: record.model.polarity,
      intensity: record.model.intensity,
      confidence: record.model.confidence,
      rationale: record.model.rationale,
    },
    analyst: {
      score100: record.review.analystSentiment.score100,
      score5: record.review.analystSentiment.score5,
      reviewState: record.review.state,
      correctionApplied: record.review.analystSentiment.correctionApplied,
    },
  };
}

function metricsFromSummary(summary: ReviewedSentimentValidationSummary): PublicShadowComparisonMetrics {
  return {
    total: summary.total,
    averageDeltaScore100: round(summary.averageDeltaScore100, 2),
    averageDeltaScore5: round(summary.averageDeltaScore5, 2),
    exactScore5MatchRate: summary.total > 0 ? round(summary.exactScore5Matches / summary.total, 4) : 0,
    withinFivePointsRate: summary.total > 0 ? round(summary.withinFivePointsScore100 / summary.total, 4) : 0,
    correctedCount: summary.correctedCount,
  };
}

function metricsFromEngagementBucket(bucket: ReviewedSentimentValidationSummary['byEngagementType'][string] | undefined): PublicShadowComparisonMetrics | undefined {
  if (!bucket) {
    return undefined;
  }

  return {
    total: bucket.total,
    averageDeltaScore100: round(bucket.averageDeltaScore100, 2),
    averageDeltaScore5: round(bucket.averageDeltaScore5, 2),
    exactScore5MatchRate: bucket.total > 0 ? round(bucket.exactScore5Matches / bucket.total, 4) : 0,
    withinFivePointsRate: bucket.total > 0 ? round(bucket.withinFivePointsScore100 / bucket.total, 4) : 0,
    correctedCount: bucket.correctedCount,
  };
}

async function collectFiles(
  rootPath: string,
  predicate: (entry: Dirent, path: string) => boolean,
): Promise<string[]> {
  const stats = await lstat(rootPath).catch(() => null);
  if (!stats) {
    return [];
  }
  if (stats.isFile()) {
    const fileEntry = {
      isFile: () => true,
      isDirectory: () => false,
    } as Dirent;
    return predicate(fileEntry, rootPath) ? [rootPath] : [];
  }

  const entries = await readdir(rootPath, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];

  for (const entry of entries) {
    const path = resolve(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(path, predicate));
      continue;
    }
    if (predicate(entry, path)) {
      files.push(path);
    }
  }

  return files;
}

function definedDifference(value: number | undefined, baseline: number | undefined): number | undefined {
  if (typeof value !== 'number' || typeof baseline !== 'number') {
    return undefined;
  }
  return round(value - baseline, 4);
}

function round(value: number, places: number): number {
  return Number(value.toFixed(places));
}
