import { lstat, readFile, readdir } from 'fs/promises';
import { join, resolve } from 'path';
import { gunzipSync } from 'zlib';
import reviewedSamplesFixture from '../../fixtures/sentiment-reviewed-outcomes.support.json';
import {
  deriveSentimentScore,
  recommendSentimentScoringConfig,
  reviewedSentimentOutcomeSampleSchema,
  reviewedSentimentOutcomeSamplesSchema,
  resolveSentimentScore100Offset,
  SentimentScoringRecommendationSummary,
} from '../sentiment/scoring';
import { reviewedRunExportRecordSchema } from '../contracts';
import { tenantAdminSentimentScoringSchema } from '../contracts/admin-config';

export interface ReviewedSentimentValidationResult {
  name: string;
  source: string;
  category: string;
  engagementType: string;
  queue?: string;
  transcriptTurnCount?: number;
  transcriptCharacterCount?: number;
  transcriptLengthBucket?: string;
  sourceDataset?: string;
  datasetTrack?: string;
  analystReviewState: string;
  analystCorrectionApplied: boolean;
  modelScore100: number;
  analystScore100: number;
  modelScore5: number;
  analystScore5: number;
  deltaScore100: number;
  deltaScore5: number;
}

export interface ReviewedSentimentValidationSummary {
  total: number;
  averageDeltaScore100: number;
  averageDeltaScore5: number;
  maxDeltaScore100: number;
  maxDeltaScore5: number;
  exactScore5Matches: number;
  withinFivePointsScore100: number;
  byReviewState: Record<string, number>;
  correctedCount: number;
  byEngagementType: Record<string, {
    total: number;
    averageDeltaScore100: number;
    averageDeltaScore5: number;
    exactScore5Matches: number;
    withinFivePointsScore100: number;
    correctedCount: number;
  }>;
}

export function runReviewedSentimentValidationFromSamples(samples: unknown): ReviewedSentimentValidationResult[] {
  const parsed = reviewedSentimentOutcomeSamplesSchema.parse(samples);
  return runReviewedSentimentValidationFromParsedSamples(parsed);
}

export function runReviewedSentimentValidationFromSamplesWithCalibration(
  samples: unknown,
  calibration: unknown,
): ReviewedSentimentValidationResult[] {
  const parsed = reviewedSentimentOutcomeSamplesSchema.parse(samples);
  const scoringConfig = tenantAdminSentimentScoringSchema.parse(calibration);
  return runReviewedSentimentValidationFromParsedSamples(parsed, scoringConfig);
}

export async function recommendSentimentScoringConfigFromDataset(
  datasetPath?: string,
  options: {
    minimumSampleSize?: number;
    minimumSampleSizePerEngagementType?: number;
  } = {},
): Promise<SentimentScoringRecommendationSummary> {
  const samples = datasetPath
    ? await loadReviewedSentimentSamples(datasetPath)
    : reviewedSamplesFixture;
  return recommendSentimentScoringConfig(samples, options);
}

function runReviewedSentimentValidationFromParsedSamples(
  parsed: ReturnType<typeof reviewedSentimentOutcomeSamplesSchema.parse>,
  scoringConfig?: ReturnType<typeof tenantAdminSentimentScoringSchema.parse>,
): ReviewedSentimentValidationResult[] {
  return parsed.map((sample) => {
    const derived = deriveSentimentScore(sample.model, {
      score100Offset: resolveSentimentScore100Offset(scoringConfig, {
        engagementType: sample.engagementType,
      }),
      context: {
        engagementType: sample.engagementType,
      },
    });
    return {
      name: sample.name,
      source: sample.source,
      category: sample.category ?? 'uncategorized',
      engagementType: sample.engagementType ?? 'UNSPECIFIED',
      queue: sample.queue,
      transcriptTurnCount: sample.transcriptTurnCount,
      transcriptCharacterCount: sample.transcriptCharacterCount,
      transcriptLengthBucket: sample.transcriptLengthBucket,
      sourceDataset: sample.sourceDataset,
      datasetTrack: sample.datasetTrack,
      analystReviewState: sample.analyst.reviewState ?? 'UNSPECIFIED',
      analystCorrectionApplied: sample.analyst.correctionApplied,
      modelScore100: derived.score100,
      analystScore100: sample.analyst.score100,
      modelScore5: derived.score5,
      analystScore5: sample.analyst.score5,
      deltaScore100: Math.abs(derived.score100 - sample.analyst.score100),
      deltaScore5: Math.abs(derived.score5 - sample.analyst.score5),
    };
  });
}

export async function runReviewedSentimentValidation(
  datasetPath?: string,
  calibrationConfigPath?: string,
): Promise<ReviewedSentimentValidationResult[]> {
  const samples = datasetPath
    ? await loadReviewedSentimentSamples(datasetPath)
    : reviewedSamplesFixture;
  if (!calibrationConfigPath) {
    return runReviewedSentimentValidationFromSamples(samples);
  }

  const rawCalibration = await readValidationDatasetText(resolve(calibrationConfigPath));
  return runReviewedSentimentValidationFromSamplesWithCalibration(samples, JSON.parse(rawCalibration));
}

async function loadReviewedSentimentSamples(datasetPath: string): Promise<unknown[]> {
  const absolutePath = resolve(datasetPath);
  const stat = await lstat(absolutePath);
  if (stat.isDirectory()) {
    const files = await collectValidationInputFiles(absolutePath);
    const samples = files.length === 0
      ? []
      : (await Promise.all(files.map(async (path) => loadSamplesFromPath(path)))).flat();
    return dedupeReviewedOutcomeSamples(samples);
  }

  const raw = await readValidationDatasetText(absolutePath);
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  return parseValidationTextToRecords(trimmed);
}

async function loadSamplesFromPath(path: string): Promise<unknown[]> {
  const raw = await readValidationDatasetText(path);
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  return parseValidationTextToRecords(trimmed);
}

async function collectValidationInputFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectValidationInputFiles(path));
      continue;
    }
    if (entry.isFile() && isValidationInputFile(path)) {
      files.push(path);
    }
  }
  return files.sort();
}

async function readValidationDatasetText(path: string): Promise<string> {
  const raw = await readFile(path);
  if (path.endsWith('.gz')) {
    return gunzipSync(raw).toString('utf8');
  }
  return raw.toString('utf8');
}

function isValidationInputFile(path: string): boolean {
  return path.endsWith('.json')
    || path.endsWith('.json.gz')
    || path.endsWith('.jsonl')
    || path.endsWith('.jsonl.gz')
    || path.endsWith('.ndjson')
    || path.endsWith('.ndjson.gz');
}

function dedupeReviewedOutcomeSamples(samples: unknown[]): unknown[] {
  const deduped = new Map<string, unknown>();
  for (const sample of samples) {
    const candidate = sample as {
      runId?: string;
      name?: string;
      reviewedAt?: string;
      analyst?: { reviewedAt?: string };
    };
    const key = [
      candidate.runId ?? candidate.name ?? JSON.stringify(sample),
      candidate.analyst?.reviewedAt ?? candidate.reviewedAt ?? '',
    ].join('::');
    deduped.set(key, sample);
  }
  return Array.from(deduped.values());
}

function normalizeLoadedSamples(input: unknown): unknown[] {
  const single = reviewedSentimentOutcomeSampleSchema.safeParse(input);
  if (single.success) {
    return [single.data];
  }

  const multiple = reviewedSentimentOutcomeSamplesSchema.safeParse(input);
  if (multiple.success) {
    return multiple.data;
  }

  const reviewedExport = reviewedRunExportRecordSchema.safeParse(input);
  if (reviewedExport.success) {
    const sample = reviewedExportRecordToSentimentSample(reviewedExport.data);
    return sample ? [sample] : [];
  }

  if (Array.isArray(input)) {
    return input.flatMap((item) => normalizeLoadedSamples(item));
  }

  return [];
}

function parseValidationTextToRecords(trimmed: string): unknown[] {
  try {
    return normalizeLoadedSamples(JSON.parse(trimmed));
  } catch {
    return normalizeLoadedSamples(trimmed
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line)));
  }
}

export function summarizeReviewedSentimentValidation(
  results: ReviewedSentimentValidationResult[],
): ReviewedSentimentValidationSummary {
  const summary = results.reduce<ReviewedSentimentValidationSummary>((summary, result) => {
    summary.total += 1;
    summary.averageDeltaScore100 += result.deltaScore100;
    summary.averageDeltaScore5 += result.deltaScore5;
    summary.maxDeltaScore100 = Math.max(summary.maxDeltaScore100, result.deltaScore100);
    summary.maxDeltaScore5 = Math.max(summary.maxDeltaScore5, result.deltaScore5);
    if (result.deltaScore5 === 0) {
      summary.exactScore5Matches += 1;
    }
    if (result.deltaScore100 <= 5) {
      summary.withinFivePointsScore100 += 1;
    }
    summary.byReviewState[result.analystReviewState] = (summary.byReviewState[result.analystReviewState] ?? 0) + 1;
    if (result.analystCorrectionApplied) {
      summary.correctedCount += 1;
    }
    return summary;
  }, {
    total: 0,
    averageDeltaScore100: 0,
    averageDeltaScore5: 0,
    maxDeltaScore100: 0,
    maxDeltaScore5: 0,
    exactScore5Matches: 0,
    withinFivePointsScore100: 0,
    byReviewState: {},
    correctedCount: 0,
    byEngagementType: {},
  });

  const byEngagementType = results.reduce<ReviewedSentimentValidationSummary['byEngagementType']>((aggregate, result) => {
    const bucket = aggregate[result.engagementType] ?? {
      total: 0,
      averageDeltaScore100: 0,
      averageDeltaScore5: 0,
      exactScore5Matches: 0,
      withinFivePointsScore100: 0,
      correctedCount: 0,
    };
    bucket.total += 1;
    bucket.averageDeltaScore100 += result.deltaScore100;
    bucket.averageDeltaScore5 += result.deltaScore5;
    if (result.deltaScore5 === 0) {
      bucket.exactScore5Matches += 1;
    }
    if (result.deltaScore100 <= 5) {
      bucket.withinFivePointsScore100 += 1;
    }
    if (result.analystCorrectionApplied) {
      bucket.correctedCount += 1;
    }
    aggregate[result.engagementType] = bucket;
    return aggregate;
  }, {});

  if (summary.total > 0) {
    summary.averageDeltaScore100 /= summary.total;
    summary.averageDeltaScore5 /= summary.total;
  }

  for (const bucket of Object.values(byEngagementType)) {
    if (bucket.total > 0) {
      bucket.averageDeltaScore100 /= bucket.total;
      bucket.averageDeltaScore5 /= bucket.total;
    }
  }

  summary.byEngagementType = byEngagementType;

  return summary;
}

function reviewedExportRecordToSentimentSample(
  record: ReturnType<typeof reviewedRunExportRecordSchema.parse>,
): unknown | null {
  if (!record.model || !record.review.analystSentiment) {
    return null;
  }

  return {
    runId: record.runId,
    tenantId: record.tenantId,
    useCase: record.useCase,
    source: 'review_export',
    engagementType: record.engagementType,
    queue: record.queue,
    transcriptTurnCount: record.transcriptTurnCount,
    transcriptCharacterCount: record.transcriptCharacterCount,
    transcriptLengthBucket: record.transcriptLengthBucket,
    sourceDataset: record.sourceDataset,
    datasetTrack: record.datasetTrack,
    name: record.runId,
    category: record.useCase,
    reviewedBy: record.review.analystSentiment.reviewedById,
    reviewedAt: record.review.analystSentiment.reviewedAt,
    note: record.review.analystSentiment.note,
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
