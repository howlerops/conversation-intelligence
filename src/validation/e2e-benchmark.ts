import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { z } from 'zod';
import {
  overallSentimentSchema,
  tenantAdminSentimentScoringSchema,
  tenantPackSchema,
  transcriptInputSchema,
  TranscriptInput,
  TenantPack,
} from '../contracts';
import { CanonicalAnalysisEngine } from '../rlm/engine';
import { analyzeConversation } from '../pipeline/analyze-conversation';
import {
  buildPublicDataPipelineSuite,
  publicDataPipelineSuiteSchema,
  publicDataPipelineSuiteOutputSchema,
} from './public-data-test-pipeline';
import { loadReviewedExportDataset } from './reviewed-export-dataset';
import { deriveTranscriptStats } from './transcript-stats';

const engagementTypeSchema = z.enum(['CALL', 'EMAIL', 'TICKET', 'CHAT', 'UNSPECIFIED']);

const benchmarkSourceFiltersSchema = z.object({
  pipelineIds: z.array(z.string().min(1)).min(1).optional(),
  recordIds: z.array(z.string().min(1)).min(1).optional(),
  engagementTypes: z.array(z.enum(['CALL', 'EMAIL', 'TICKET', 'CHAT'])).min(1).optional(),
});

const benchmarkSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    sourceId: z.string().min(1),
    kind: z.literal('public_pipeline_suite'),
    path: z.string().min(1),
    tenantPackPath: z.string().min(1),
    sentimentScoringPath: z.string().min(1).optional(),
  }).merge(benchmarkSourceFiltersSchema),
  z.object({
    sourceId: z.string().min(1),
    kind: z.literal('reviewed_run_exports'),
    path: z.string().min(1),
    tenantPackPath: z.string().min(1),
    sentimentScoringPath: z.string().min(1).optional(),
    requireAnalystSentiment: z.boolean().default(true),
  }).merge(benchmarkSourceFiltersSchema.omit({ pipelineIds: true })),
]);

export const e2eBenchmarkSuiteSchema = z.object({
  sources: z.array(benchmarkSourceSchema).min(1),
});

export type E2eBenchmarkSuite = z.infer<typeof e2eBenchmarkSuiteSchema>;
export type E2eBenchmarkSuiteSource = E2eBenchmarkSuite['sources'][number];

const benchmarkExpectedSentimentSchema = z.object({
  score100: z.number().int().min(0).max(100),
  score5: z.number().int().min(1).max(5),
  reviewState: z.enum(['VERIFIED', 'NEEDS_REVIEW', 'UNCERTAIN']).optional(),
  correctionApplied: z.boolean().default(false),
  sourceDataset: z.string().min(1).optional(),
  datasetTrack: z.enum(['OPEN_CORE', 'RESEARCH_ONLY', 'SYNTHETIC']).optional(),
});

export const e2eBenchmarkRecordResultSchema = z.object({
  sourceId: z.string().min(1),
  recordId: z.string().min(1),
  tenantId: z.string().min(1),
  useCase: z.string().min(1),
  engagementType: z.enum(['CALL', 'EMAIL', 'TICKET', 'CHAT', 'UNSPECIFIED']),
  queue: z.string().min(1).optional(),
  transcriptLengthBucket: z.enum(['SHORT', 'MEDIUM', 'LONG', 'VERY_LONG']),
  transcriptTurnCount: z.number().int().min(0),
  transcriptCharacterCount: z.number().int().min(0),
  status: z.enum(['COMPLETED', 'FAILED']),
  durationMs: z.number().int().min(0),
  reviewState: z.enum(['VERIFIED', 'NEEDS_REVIEW', 'UNCERTAIN']).optional(),
  reviewReasons: z.array(z.string()).default([]),
  packVersion: z.string().min(1),
  sentiment: overallSentimentSchema.nullable(),
  expectedSentiment: benchmarkExpectedSentimentSchema.optional(),
  deltaScore100: z.number().int().min(0).max(100).optional(),
  deltaScore5: z.number().int().min(0).max(4).optional(),
  reviewStateMatchesExpected: z.boolean().optional(),
  errorMessage: z.string().min(1).optional(),
});

export type E2eBenchmarkRecordResult = z.infer<typeof e2eBenchmarkRecordResultSchema>;

const benchmarkAggregateSchema = z.object({
  total: z.number().int().min(0),
  completed: z.number().int().min(0),
  failed: z.number().int().min(0),
  compared: z.number().int().min(0),
  reviewCount: z.number().int().min(0),
  uncertainCount: z.number().int().min(0),
  averageDurationMs: z.number().min(0),
  p95DurationMs: z.number().min(0),
  averageDeltaScore100: z.number().min(0).optional(),
  averageDeltaScore5: z.number().min(0).optional(),
  exactScore5MatchRate: z.number().min(0).max(1).optional(),
  withinFivePointsRate: z.number().min(0).max(1).optional(),
  reviewStateMatchRate: z.number().min(0).max(1).optional(),
});

export type E2eBenchmarkAggregate = z.infer<typeof benchmarkAggregateSchema>;

export const e2eBenchmarkSummarySchema = z.object({
  totalRecords: z.number().int().min(0),
  bySource: z.record(z.string(), benchmarkAggregateSchema),
  byEngagementType: z.record(z.string(), benchmarkAggregateSchema),
  byQueue: z.record(z.string(), benchmarkAggregateSchema),
  byTranscriptLengthBucket: z.record(z.string(), benchmarkAggregateSchema),
  overall: benchmarkAggregateSchema,
});

export type E2eBenchmarkSummary = z.infer<typeof e2eBenchmarkSummarySchema>;

export const e2eBenchmarkReportSchema = z.object({
  generatedAt: z.string().min(1),
  summary: e2eBenchmarkSummarySchema,
  records: z.array(e2eBenchmarkRecordResultSchema),
});

export type E2eBenchmarkReport = z.infer<typeof e2eBenchmarkReportSchema>;

interface BenchmarkInputRecord {
  sourceId: string;
  recordId: string;
  pipelineId?: string;
  transcript: TranscriptInput;
  tenantPack: TenantPack;
  sentimentScoringPath?: string;
  expectedSentiment?: z.infer<typeof benchmarkExpectedSentimentSchema>;
}

export interface E2eBenchmarkProgressUpdate {
  index: number;
  total: number;
  sourceId: string;
  recordId: string;
  pipelineId?: string;
  engagementType: 'CALL' | 'EMAIL' | 'TICKET' | 'CHAT' | 'UNSPECIFIED';
  queue?: string;
}

export interface E2eBenchmarkTarget extends E2eBenchmarkProgressUpdate {
  kind: E2eBenchmarkSuiteSource['kind'];
  source: E2eBenchmarkSuiteSource;
  tenantId: string;
  useCase: string;
  packVersion: string;
  transcriptLengthBucket: 'SHORT' | 'MEDIUM' | 'LONG' | 'VERY_LONG';
  transcriptTurnCount: number;
  transcriptCharacterCount: number;
}

export interface RunE2eBenchmarkOptions {
  engine: CanonicalAnalysisEngine;
  now?: () => Date;
  concurrency?: number;
  maxRecordsPerSource?: number;
  calibrationConfigPath?: string;
  perRecordTimeoutMs?: number;
  onRecordStart?: (update: E2eBenchmarkProgressUpdate) => void | Promise<void>;
  onRecordComplete?: (
    update: E2eBenchmarkProgressUpdate & {
      result: E2eBenchmarkRecordResult;
    },
  ) => void | Promise<void>;
}

export async function loadE2eBenchmarkSuiteFromPath(path: string): Promise<E2eBenchmarkSuite> {
  const absolutePath = resolve(path);
  const rootDir = dirname(absolutePath);
  const raw = JSON.parse(await readTextFile(absolutePath));
  const suite = e2eBenchmarkSuiteSchema.parse(raw);

  return e2eBenchmarkSuiteSchema.parse({
    sources: suite.sources.map((source) => ({
      ...source,
      path: resolve(rootDir, source.path),
      tenantPackPath: resolve(rootDir, source.tenantPackPath),
      sentimentScoringPath: source.sentimentScoringPath ? resolve(rootDir, source.sentimentScoringPath) : undefined,
    })),
  });
}

export async function runE2eBenchmarkSuite(
  suiteInput: unknown,
  options: RunE2eBenchmarkOptions,
): Promise<E2eBenchmarkReport> {
  const suite = e2eBenchmarkSuiteSchema.parse(suiteInput);
  const records = await loadBenchmarkRecords(suite, options.maxRecordsPerSource);
  const calibrationConfig = options.calibrationConfigPath
    ? tenantAdminSentimentScoringSchema.parse(JSON.parse(await readTextFile(options.calibrationConfigPath)))
    : undefined;

  const concurrency = Math.max(1, options.concurrency ?? 1);
  const now = options.now ?? (() => new Date());
  const results = await mapWithConcurrency(records, concurrency, async (record, index) => {
    const transcriptStats = deriveTranscriptStats(record.transcript);
    const startedAt = Date.now();
    const progressUpdate: E2eBenchmarkProgressUpdate = {
      index,
      total: records.length,
      sourceId: record.sourceId,
      recordId: record.recordId,
      pipelineId: record.pipelineId,
      engagementType: resolveEngagementType(record.transcript.metadata.engagementType),
      queue: typeof record.transcript.metadata.queue === 'string' ? record.transcript.metadata.queue : undefined,
    };
    await options.onRecordStart?.(progressUpdate);

    const sentimentScoringConfig = record.sentimentScoringPath
      ? tenantAdminSentimentScoringSchema.parse(JSON.parse(await readTextFile(record.sentimentScoringPath)))
      : calibrationConfig;
    const timeoutController = typeof options.perRecordTimeoutMs === 'number' && options.perRecordTimeoutMs > 0
      ? new AbortController()
      : null;
    const timeoutHandle = timeoutController
      ? setTimeout(() => timeoutController.abort(
        new Error(`Benchmark record timed out after ${options.perRecordTimeoutMs}ms`),
      ), options.perRecordTimeoutMs)
      : undefined;
    try {
      const analysis = await analyzeConversation(record.transcript, record.tenantPack, {
        engine: options.engine,
        now: now(),
        sentimentScoringConfig,
        signal: timeoutController?.signal,
      });
      const durationMs = Date.now() - startedAt;
      const score = analysis.overallEndUserSentiment?.score;
      const deltaScore100 = record.expectedSentiment && score
        ? Math.abs(score.score100 - record.expectedSentiment.score100)
        : undefined;
      const deltaScore5 = record.expectedSentiment && score
        ? Math.abs(score.score5 - record.expectedSentiment.score5)
        : undefined;
      const result = e2eBenchmarkRecordResultSchema.parse({
        sourceId: record.sourceId,
        recordId: record.recordId,
        tenantId: record.transcript.tenantId,
        useCase: record.transcript.useCase,
        engagementType: resolveEngagementType(record.transcript.metadata.engagementType),
        queue: typeof record.transcript.metadata.queue === 'string' ? record.transcript.metadata.queue : undefined,
        transcriptLengthBucket: transcriptStats.transcriptLengthBucket,
        transcriptTurnCount: transcriptStats.transcriptTurnCount,
        transcriptCharacterCount: transcriptStats.transcriptCharacterCount,
        status: 'COMPLETED',
        durationMs,
        reviewState: analysis.review.state,
        reviewReasons: analysis.review.reasons,
        packVersion: record.tenantPack.packVersion,
        sentiment: analysis.overallEndUserSentiment,
        expectedSentiment: record.expectedSentiment,
        deltaScore100,
        deltaScore5,
        reviewStateMatchesExpected: record.expectedSentiment?.reviewState
          ? analysis.review.state === record.expectedSentiment.reviewState
          : undefined,
      });
      await options.onRecordComplete?.({
        ...progressUpdate,
        result,
      });
      return result;
    } catch (error) {
      const result = e2eBenchmarkRecordResultSchema.parse({
        sourceId: record.sourceId,
        recordId: record.recordId,
        tenantId: record.transcript.tenantId,
        useCase: record.transcript.useCase,
        engagementType: resolveEngagementType(record.transcript.metadata.engagementType),
        queue: typeof record.transcript.metadata.queue === 'string' ? record.transcript.metadata.queue : undefined,
        transcriptLengthBucket: transcriptStats.transcriptLengthBucket,
        transcriptTurnCount: transcriptStats.transcriptTurnCount,
        transcriptCharacterCount: transcriptStats.transcriptCharacterCount,
        status: 'FAILED',
        durationMs: Date.now() - startedAt,
        reviewReasons: [],
        packVersion: record.tenantPack.packVersion,
        sentiment: null,
        expectedSentiment: record.expectedSentiment,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      await options.onRecordComplete?.({
        ...progressUpdate,
        result,
      });
      return result;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  });

  const report = e2eBenchmarkReportSchema.parse({
    generatedAt: now().toISOString(),
    summary: buildBenchmarkSummary(results),
    records: results,
  });

  return report;
}

export async function listE2eBenchmarkTargets(
  suiteInput: unknown,
  maxRecordsPerSource?: number,
): Promise<E2eBenchmarkTarget[]> {
  const suite = e2eBenchmarkSuiteSchema.parse(suiteInput);
  const records = await loadBenchmarkRecords(suite, maxRecordsPerSource);

  return records.map((record, index) => {
    const transcriptStats = deriveTranscriptStats(record.transcript);
    const source = suite.sources.find((item) => item.sourceId === record.sourceId);
    if (!source) {
      throw new Error(`Unknown benchmark source ${record.sourceId}`);
    }

    return {
      index,
      total: records.length,
      sourceId: record.sourceId,
      recordId: record.recordId,
      pipelineId: record.pipelineId,
      engagementType: resolveEngagementType(record.transcript.metadata.engagementType),
      queue: typeof record.transcript.metadata.queue === 'string' ? record.transcript.metadata.queue : undefined,
      kind: source.kind,
      source,
      tenantId: record.transcript.tenantId,
      useCase: record.transcript.useCase,
      packVersion: record.tenantPack.packVersion,
      transcriptLengthBucket: transcriptStats.transcriptLengthBucket,
      transcriptTurnCount: transcriptStats.transcriptTurnCount,
      transcriptCharacterCount: transcriptStats.transcriptCharacterCount,
    };
  });
}

export async function writeE2eBenchmarkArtifacts(outputDir: string, report: E2eBenchmarkReport): Promise<{
  summaryPath: string;
  recordsPath: string;
}> {
  const parsed = e2eBenchmarkReportSchema.parse(report);
  await mkdir(outputDir, { recursive: true });
  const summaryPath = join(outputDir, 'summary.json');
  const recordsPath = join(outputDir, 'records.jsonl');
  await writeFile(summaryPath, JSON.stringify({
    generatedAt: parsed.generatedAt,
    summary: parsed.summary,
  }, null, 2));
  await writeFile(recordsPath, `${parsed.records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return { summaryPath, recordsPath };
}

export function buildE2eBenchmarkSummary(records: E2eBenchmarkRecordResult[]): E2eBenchmarkSummary {
  return buildBenchmarkSummary(records);
}

async function loadBenchmarkRecords(
  suite: E2eBenchmarkSuite,
  maxRecordsPerSource?: number,
): Promise<BenchmarkInputRecord[]> {
  const records: BenchmarkInputRecord[] = [];

  for (const source of suite.sources) {
    const tenantPack = tenantPackSchema.parse(JSON.parse(await readTextFile(source.tenantPackPath)));
    const sourceRecords = source.kind === 'public_pipeline_suite'
      ? await loadPublicPipelineBenchmarkRecords(source, tenantPack)
      : await loadReviewedExportBenchmarkRecords(source, tenantPack);

    records.push(...(typeof maxRecordsPerSource === 'number'
      ? sourceRecords.slice(0, maxRecordsPerSource)
      : sourceRecords));
  }

  return records;
}

async function loadPublicPipelineBenchmarkRecords(
  source: Extract<E2eBenchmarkSuite['sources'][number], { kind: 'public_pipeline_suite' }>,
  tenantPack: TenantPack,
): Promise<BenchmarkInputRecord[]> {
  const suite = publicDataPipelineSuiteSchema.parse(JSON.parse(await readTextFile(source.path)));
  const built = buildPublicDataPipelineSuite(suite, () => new Date('2026-03-28T00:00:00.000Z'));
  const parsed = publicDataPipelineSuiteOutputSchema.parse(built);

  return parsed.pipelines
    .flatMap((pipeline) => pipeline.records.map((record) => ({
      sourceId: source.sourceId,
      recordId: `${pipeline.pipelineId}:${record.sourceRecordId}`,
      pipelineId: pipeline.pipelineId,
      transcript: transcriptInputSchema.parse(record.transcript),
      tenantPack,
      sentimentScoringPath: source.sentimentScoringPath,
      expectedSentiment: record.reviewedSentimentSample
        ? benchmarkExpectedSentimentSchema.parse({
          score100: record.reviewedSentimentSample.analyst.score100,
          score5: record.reviewedSentimentSample.analyst.score5,
          reviewState: record.reviewedSentimentSample.analyst.reviewState,
          correctionApplied: record.reviewedSentimentSample.analyst.correctionApplied,
          sourceDataset: record.reviewedSentimentSample.sourceDataset,
          datasetTrack: record.reviewedSentimentSample.datasetTrack,
        })
        : undefined,
    })))
    .filter((record) => matchesBenchmarkSourceFilters(record, source));
}

async function loadReviewedExportBenchmarkRecords(
  source: Extract<E2eBenchmarkSuite['sources'][number], { kind: 'reviewed_run_exports' }>,
  tenantPack: TenantPack,
): Promise<BenchmarkInputRecord[]> {
  const reviewedRecords = await loadReviewedExportDataset(source.path, {
    requireAnalystSentiment: source.requireAnalystSentiment,
    requireTranscript: true,
  });
  const records: BenchmarkInputRecord[] = [];

  for (const reviewedRecord of reviewedRecords) {
    const record: BenchmarkInputRecord = {
      sourceId: source.sourceId,
      recordId: reviewedRecord.runId,
      transcript: transcriptInputSchema.parse(reviewedRecord.transcript),
      tenantPack,
      sentimentScoringPath: source.sentimentScoringPath,
      expectedSentiment: reviewedRecord.review.analystSentiment
        ? benchmarkExpectedSentimentSchema.parse({
          score100: reviewedRecord.review.analystSentiment.score100,
          score5: reviewedRecord.review.analystSentiment.score5,
          reviewState: reviewedRecord.review.state,
          correctionApplied: reviewedRecord.review.analystSentiment.correctionApplied,
          sourceDataset: reviewedRecord.sourceDataset,
          datasetTrack: reviewedRecord.datasetTrack,
        })
        : undefined,
    };

    if (!matchesBenchmarkSourceFilters(record, source)) {
      continue;
    }

    records.push(record);
  }

  return records;
}

function matchesBenchmarkSourceFilters(
  record: BenchmarkInputRecord,
  source: E2eBenchmarkSuite['sources'][number],
): boolean {
  if (source.kind === 'public_pipeline_suite' && source.pipelineIds && !source.pipelineIds.includes(record.pipelineId ?? '')) {
    return false;
  }
  if (source.recordIds && !source.recordIds.includes(record.recordId)) {
    return false;
  }
  if (source.engagementTypes) {
    const engagementType = resolveEngagementType(record.transcript.metadata.engagementType);
    if (engagementType === 'UNSPECIFIED' || !source.engagementTypes.includes(engagementType)) {
      return false;
    }
  }
  return true;
}

async function readTextFile(path: string): Promise<string> {
  const raw = await readFile(path);
  return raw.toString('utf8');
}

function buildBenchmarkSummary(records: E2eBenchmarkRecordResult[]): E2eBenchmarkSummary {
  return e2eBenchmarkSummarySchema.parse({
    totalRecords: records.length,
    bySource: aggregateBy(records, (record) => record.sourceId),
    byEngagementType: aggregateBy(records, (record) => record.engagementType),
    byQueue: aggregateBy(records, (record) => record.queue ?? 'UNSPECIFIED'),
    byTranscriptLengthBucket: aggregateBy(records, (record) => record.transcriptLengthBucket),
    overall: summarizeAggregate(records),
  });
}

function aggregateBy(
  records: E2eBenchmarkRecordResult[],
  keyFn: (record: E2eBenchmarkRecordResult) => string,
): Record<string, E2eBenchmarkAggregate> {
  const buckets = new Map<string, E2eBenchmarkRecordResult[]>();
  for (const record of records) {
    const key = keyFn(record);
    const bucket = buckets.get(key) ?? [];
    bucket.push(record);
    buckets.set(key, bucket);
  }

  return Object.fromEntries(Array.from(buckets.entries()).map(([key, bucket]) => [key, summarizeAggregate(bucket)]));
}

function summarizeAggregate(records: E2eBenchmarkRecordResult[]): E2eBenchmarkAggregate {
  const completed = records.filter((record) => record.status === 'COMPLETED');
  const compared = completed.filter((record) => typeof record.deltaScore100 === 'number' && typeof record.deltaScore5 === 'number');
  const durations = records.map((record) => record.durationMs).sort((left, right) => left - right);
  const reviewStateMatches = completed.filter((record) => typeof record.reviewStateMatchesExpected === 'boolean');

  return benchmarkAggregateSchema.parse({
    total: records.length,
    completed: completed.length,
    failed: records.filter((record) => record.status === 'FAILED').length,
    compared: compared.length,
    reviewCount: completed.filter((record) => record.reviewState === 'NEEDS_REVIEW').length,
    uncertainCount: completed.filter((record) => record.reviewState === 'UNCERTAIN').length,
    averageDurationMs: durations.length === 0 ? 0 : Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(2)),
    p95DurationMs: percentile(durations, 0.95),
    averageDeltaScore100: compared.length === 0 ? undefined : Number((compared.reduce((sum, record) => sum + (record.deltaScore100 ?? 0), 0) / compared.length).toFixed(2)),
    averageDeltaScore5: compared.length === 0 ? undefined : Number((compared.reduce((sum, record) => sum + (record.deltaScore5 ?? 0), 0) / compared.length).toFixed(2)),
    exactScore5MatchRate: compared.length === 0 ? undefined : Number((compared.filter((record) => record.deltaScore5 === 0).length / compared.length).toFixed(4)),
    withinFivePointsRate: compared.length === 0 ? undefined : Number((compared.filter((record) => (record.deltaScore100 ?? Number.POSITIVE_INFINITY) <= 5).length / compared.length).toFixed(4)),
    reviewStateMatchRate: reviewStateMatches.length === 0 ? undefined : Number((reviewStateMatches.filter((record) => record.reviewStateMatchesExpected).length / reviewStateMatches.length).toFixed(4)),
  });
}

function percentile(values: number[], target: number): number {
  if (values.length === 0) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * target) - 1));
  return values[index] ?? 0;
}

function resolveEngagementType(value: unknown): 'CALL' | 'EMAIL' | 'TICKET' | 'CHAT' | 'UNSPECIFIED' {
  return value === 'CALL' || value === 'EMAIL' || value === 'TICKET' || value === 'CHAT'
    ? value
    : 'UNSPECIFIED';
}

async function mapWithConcurrency<T, U>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let cursor = 0;

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const current = cursor;
      cursor += 1;
      results[current] = await worker(values[current]!, current);
    }
  }));

  return results;
}
