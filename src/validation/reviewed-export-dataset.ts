import { lstat, readFile, readdir } from 'fs/promises';
import { basename, join, resolve } from 'path';
import { gunzipSync } from 'zlib';
import {
  ReviewedRunExportRecord,
  reviewedRunExportRecordSchema,
} from '../contracts';

export interface LoadReviewedExportDatasetOptions {
  requireTranscript?: boolean;
  requireAnalystSentiment?: boolean;
}

export interface ReviewedExportDatasetSummary {
  sourcePath: string;
  fileCount: number;
  recordCount: number;
  transcriptRecordCount: number;
  analystSentimentCount: number;
  latestUpdatedAt?: string;
  byEngagementType: Record<string, number>;
  byQueue: Record<string, number>;
  byTranscriptLengthBucket: Record<string, number>;
}

export async function collectReviewedExportDatasetFiles(inputPath: string): Promise<string[]> {
  const absolutePath = resolve(inputPath);
  const stat = await lstat(absolutePath);
  if (!stat.isDirectory()) {
    return [absolutePath];
  }

  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(absolutePath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectReviewedExportDatasetFiles(entryPath));
      continue;
    }
    if (entry.isFile() && isReviewedExportDatasetFile(entryPath)) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

export async function loadReviewedExportDataset(
  inputPath: string,
  options: LoadReviewedExportDatasetOptions = {},
): Promise<ReviewedRunExportRecord[]> {
  const files = await collectReviewedExportDatasetFiles(inputPath);
  const recordsByRunId = new Map<string, ReviewedRunExportRecord>();

  for (const file of files) {
    const loaded = await loadReviewedExportRecordsFromFile(file);
    for (const record of loaded) {
      if (options.requireTranscript && !record.transcript) {
        continue;
      }
      if (options.requireAnalystSentiment && !record.review.analystSentiment) {
        continue;
      }
      const existing = recordsByRunId.get(record.runId);
      if (!existing || reviewedRecordTimestamp(record) >= reviewedRecordTimestamp(existing)) {
        recordsByRunId.set(record.runId, record);
      }
    }
  }

  return Array.from(recordsByRunId.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function summarizeReviewedExportDataset(
  inputPath: string,
  options: LoadReviewedExportDatasetOptions = {},
): Promise<ReviewedExportDatasetSummary> {
  const files = await collectReviewedExportDatasetFiles(inputPath);
  const records = await loadReviewedExportDataset(inputPath, options);
  const byEngagementType: Record<string, number> = {};
  const byQueue: Record<string, number> = {};
  const byTranscriptLengthBucket: Record<string, number> = {};
  let transcriptRecordCount = 0;
  let analystSentimentCount = 0;
  let latestUpdatedAt: string | undefined;

  for (const record of records) {
    if (record.transcript) {
      transcriptRecordCount += 1;
    }
    if (record.review.analystSentiment) {
      analystSentimentCount += 1;
    }
    if (record.engagementType) {
      byEngagementType[record.engagementType] = (byEngagementType[record.engagementType] ?? 0) + 1;
    }
    if (record.queue) {
      byQueue[record.queue] = (byQueue[record.queue] ?? 0) + 1;
    }
    if (record.transcriptLengthBucket) {
      byTranscriptLengthBucket[record.transcriptLengthBucket] = (byTranscriptLengthBucket[record.transcriptLengthBucket] ?? 0) + 1;
    }
    if (!latestUpdatedAt || record.updatedAt > latestUpdatedAt) {
      latestUpdatedAt = record.updatedAt;
    }
  }

  return {
    sourcePath: resolve(inputPath),
    fileCount: files.length,
    recordCount: records.length,
    transcriptRecordCount,
    analystSentimentCount,
    latestUpdatedAt,
    byEngagementType,
    byQueue,
    byTranscriptLengthBucket,
  };
}

async function loadReviewedExportRecordsFromFile(path: string): Promise<ReviewedRunExportRecord[]> {
  const raw = await readReviewedExportText(path);
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  const parsed = parseUnknownRecords(trimmed);
  const records: ReviewedRunExportRecord[] = [];
  for (const item of parsed) {
    const candidate = reviewedRunExportRecordSchema.safeParse(item);
    if (candidate.success) {
      records.push(candidate.data);
    }
  }

  return records;
}

async function readReviewedExportText(path: string): Promise<string> {
  const raw = await readFile(path);
  if (path.endsWith('.gz')) {
    return gunzipSync(raw).toString('utf8');
  }
  return raw.toString('utf8');
}

function parseUnknownRecords(trimmed: string): unknown[] {
  try {
    return normalizeUnknownRecords(JSON.parse(trimmed));
  } catch {
    return normalizeUnknownRecords(trimmed
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line)));
  }
}

function normalizeUnknownRecords(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return input;
  }
  if (input && typeof input === 'object') {
    return [input];
  }
  return [];
}

function isReviewedExportDatasetFile(path: string): boolean {
  const name = basename(path);
  if (name.endsWith('.manifest.json') || name === 'summary.json' || name === 'pipeline.json') {
    return false;
  }
  return path.endsWith('.json')
    || path.endsWith('.json.gz')
    || path.endsWith('.jsonl')
    || path.endsWith('.jsonl.gz')
    || path.endsWith('.ndjson')
    || path.endsWith('.ndjson.gz');
}

function reviewedRecordTimestamp(record: ReviewedRunExportRecord): number {
  const candidates = [
    record.review.analystSentiment?.reviewedAt,
    record.review.reviewedAt,
    record.updatedAt,
    record.createdAt,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}
