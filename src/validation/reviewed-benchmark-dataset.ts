import { createHash } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { gzipSync } from 'zlib';
import { z } from 'zod';
import {
  ReviewedRunExportManifest,
  ReviewedRunExportRecord,
  reviewedRunExportManifestSchema,
  reviewedRunExportRecordSchema,
  transcriptInputSchema,
  transcriptLengthBucketSchema,
} from '../contracts';
import { deriveScore5FromScore100 } from '../sentiment/scoring';
import {
  buildPublicDataPipelineSuite,
  PublicDataPipelineSuiteOutput,
  publicDataPipelineSuiteOutputSchema,
  publicDataPipelineSuiteSchema,
} from './public-data-test-pipeline';

const benchmarkReviewDecisionSchema = z.enum(['VERIFY', 'MARK_UNCERTAIN', 'KEEP_NEEDS_REVIEW']);

export const benchmarkAnnotationTemplateSchema = z.object({
  polarity: z.enum(['VERY_NEGATIVE', 'NEGATIVE', 'NEUTRAL', 'POSITIVE', 'VERY_POSITIVE']).optional(),
  intensity: z.number().min(0).max(1).optional(),
  score100: z.number().int().min(0).max(100).optional(),
  score5: z.number().int().min(1).max(5).optional(),
  reviewState: z.enum(['VERIFIED', 'UNCERTAIN', 'NEEDS_REVIEW']).default('VERIFIED'),
  correctionApplied: z.boolean().default(false),
  rationale: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
});

export type BenchmarkAnnotationTemplate = z.infer<typeof benchmarkAnnotationTemplateSchema>;

export const benchmarkAnnotationCandidateSchema = z.object({
  candidateId: z.string().min(1),
  pipelineId: z.string().min(1),
  sourceRecordId: z.string().min(1),
  tenantId: z.string().min(1),
  useCase: z.string().min(1),
  sourceDataset: z.string().min(1),
  datasetTrack: z.enum(['OPEN_CORE', 'RESEARCH_ONLY', 'SYNTHETIC']),
  engagementType: z.enum(['CALL', 'EMAIL', 'TICKET', 'CHAT']),
  queue: z.string().min(1).optional(),
  transcriptTurnCount: z.number().int().min(0),
  transcriptCharacterCount: z.number().int().min(0),
  transcriptLengthBucket: transcriptLengthBucketSchema,
  canonicalEventLabels: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().min(1)).default([]),
  transcript: transcriptInputSchema,
  annotationTemplate: benchmarkAnnotationTemplateSchema.default({
    reviewState: 'VERIFIED',
    correctionApplied: false,
  }),
});

export type BenchmarkAnnotationCandidate = z.infer<typeof benchmarkAnnotationCandidateSchema>;

export const benchmarkAnnotationBatchSchema = z.object({
  generatedAt: z.string().min(1),
  sourceManifests: z.array(z.string().min(1)).default([]),
  candidateCount: z.number().int().min(0),
  byEngagementType: z.record(z.string(), z.number().int().min(0)).default({}),
  bySourceDataset: z.record(z.string(), z.number().int().min(0)).default({}),
  candidates: z.array(benchmarkAnnotationCandidateSchema),
});

export type BenchmarkAnnotationBatch = z.infer<typeof benchmarkAnnotationBatchSchema>;

export const reviewedBenchmarkDatasetSummarySchema = z.object({
  generatedAt: z.string().min(1),
  manifestPaths: z.array(z.string().min(1)).default([]),
  scopeCount: z.number().int().min(0),
  recordCount: z.number().int().min(0),
  annotationCandidateCount: z.number().int().min(0),
  byEngagementType: z.record(z.string(), z.number().int().min(0)).default({}),
  bySourceDataset: z.record(z.string(), z.number().int().min(0)).default({}),
  byQueue: z.record(z.string(), z.number().int().min(0)).default({}),
  byTranscriptLengthBucket: z.record(z.string(), z.number().int().min(0)).default({}),
});

export type ReviewedBenchmarkDatasetSummary = z.infer<typeof reviewedBenchmarkDatasetSummarySchema>;

export interface ReviewedBenchmarkScope {
  tenantId: string;
  useCase: string;
  records: ReviewedRunExportRecord[];
}

export interface ReviewedBenchmarkDataset {
  generatedAt: string;
  classification: 'INTERNAL' | 'RESTRICTED';
  manifestPaths: string[];
  scopes: ReviewedBenchmarkScope[];
  annotationBatch: BenchmarkAnnotationBatch;
  summary: ReviewedBenchmarkDatasetSummary;
}

export interface BuildReviewedBenchmarkDatasetOptions {
  generatedAt?: string;
  packVersion?: string;
  promptVersion?: string;
  classification?: 'INTERNAL' | 'RESTRICTED';
  includeTranscript?: boolean;
}

export interface WriteReviewedBenchmarkDatasetOptions {
  latestFilename?: string;
  snapshotFilename?: string;
  annotationFilename?: string;
}

export interface ReviewedBenchmarkDatasetArtifacts {
  outputRootDir: string;
  summaryPath: string;
  annotationBatchPath: string;
  scopeArtifacts: Array<{
    tenantId: string;
    useCase: string;
    latestPath: string;
    snapshotPath: string;
    manifestPath: string;
    recordCount: number;
  }>;
}

export function buildReviewedBenchmarkDataset(
  inputs: Array<{ path: string; content: unknown }>,
  options: BuildReviewedBenchmarkDatasetOptions = {},
): ReviewedBenchmarkDataset {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const classification = options.classification ?? 'INTERNAL';
  const includeTranscript = options.includeTranscript ?? true;
  const packVersion = options.packVersion ?? 'public-benchmark-v1';
  const promptVersion = options.promptVersion ?? 'public-benchmark-labels-v1';
  const scopesByKey = new Map<string, ReviewedBenchmarkScope>();
  const annotationCandidates: BenchmarkAnnotationCandidate[] = [];
  const byEngagementType: Record<string, number> = {};
  const bySourceDataset: Record<string, number> = {};
  const byQueue: Record<string, number> = {};
  const byTranscriptLengthBucket: Record<string, number> = {};

  for (const input of inputs) {
    const suite = normalizePublicPipelineSuiteOutput(input.content, generatedAt);
    for (const pipeline of suite.pipelines) {
      for (const record of pipeline.records) {
        if (record.reviewedSentimentSample) {
          const exportRecord = toReviewedRunExportRecord(record, {
            packVersion,
            promptVersion,
            includeTranscript,
            reviewedAtFallback: generatedAt,
          });
          const scope = getOrCreateScope(scopesByKey, exportRecord.tenantId, exportRecord.useCase);
          scope.records.push(exportRecord);
          byEngagementType[exportRecord.engagementType ?? 'UNSPECIFIED'] = (byEngagementType[exportRecord.engagementType ?? 'UNSPECIFIED'] ?? 0) + 1;
          if (exportRecord.sourceDataset) {
            bySourceDataset[exportRecord.sourceDataset] = (bySourceDataset[exportRecord.sourceDataset] ?? 0) + 1;
          }
          if (exportRecord.queue) {
            byQueue[exportRecord.queue] = (byQueue[exportRecord.queue] ?? 0) + 1;
          }
          if (exportRecord.transcriptLengthBucket) {
            byTranscriptLengthBucket[exportRecord.transcriptLengthBucket] = (byTranscriptLengthBucket[exportRecord.transcriptLengthBucket] ?? 0) + 1;
          }
        } else {
          annotationCandidates.push(toBenchmarkAnnotationCandidate(record));
        }
      }
    }
  }

  const scopes = Array.from(scopesByKey.values())
    .map((scope) => ({
      ...scope,
      records: scope.records
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    }))
    .sort((left, right) => `${left.tenantId}/${left.useCase}`.localeCompare(`${right.tenantId}/${right.useCase}`));

  const annotationBatch = benchmarkAnnotationBatchSchema.parse({
    generatedAt,
    sourceManifests: inputs.map((input) => resolve(input.path)),
    candidateCount: annotationCandidates.length,
    byEngagementType: summarizeAnnotationCandidates(annotationCandidates, (candidate) => candidate.engagementType),
    bySourceDataset: summarizeAnnotationCandidates(annotationCandidates, (candidate) => candidate.sourceDataset),
    candidates: annotationCandidates,
  });

  const summary = reviewedBenchmarkDatasetSummarySchema.parse({
    generatedAt,
    manifestPaths: inputs.map((input) => resolve(input.path)),
    scopeCount: scopes.length,
    recordCount: scopes.reduce((sum, scope) => sum + scope.records.length, 0),
    annotationCandidateCount: annotationCandidates.length,
    byEngagementType,
    bySourceDataset,
    byQueue,
    byTranscriptLengthBucket,
  });

  return {
    generatedAt,
    classification,
    manifestPaths: summary.manifestPaths,
    scopes,
    annotationBatch,
    summary,
  };
}

export async function writeReviewedBenchmarkDataset(
  outputRootDir: string,
  dataset: ReviewedBenchmarkDataset,
  options: WriteReviewedBenchmarkDatasetOptions = {},
): Promise<ReviewedBenchmarkDatasetArtifacts> {
  const absoluteOutputRootDir = resolve(outputRootDir);
  const latestFilename = options.latestFilename ?? 'latest.jsonl';
  const annotationFilename = options.annotationFilename ?? 'annotation-candidates.jsonl';
  const summaryPath = join(absoluteOutputRootDir, 'summary.json');
  const annotationBatchPath = join(absoluteOutputRootDir, annotationFilename);
  const snapshotSuffix = sanitizeTimestamp(dataset.generatedAt);
  const scopeArtifacts: ReviewedBenchmarkDatasetArtifacts['scopeArtifacts'] = [];

  await writeJson(summaryPath, dataset.summary);
  await writeJsonl(annotationBatchPath, dataset.annotationBatch.candidates);
  await writeJson(join(absoluteOutputRootDir, 'annotation-batch.summary.json'), {
    generatedAt: dataset.annotationBatch.generatedAt,
    sourceManifests: dataset.annotationBatch.sourceManifests,
    candidateCount: dataset.annotationBatch.candidateCount,
    byEngagementType: dataset.annotationBatch.byEngagementType,
    bySourceDataset: dataset.annotationBatch.bySourceDataset,
  });

  for (const scope of dataset.scopes) {
    const scopeDir = join(absoluteOutputRootDir, scope.tenantId, scope.useCase);
    const latestPath = join(scopeDir, latestFilename);
    const snapshotFilename = options.snapshotFilename ?? `${snapshotSuffix}.jsonl.gz`;
    const snapshotPath = join(scopeDir, 'snapshots', snapshotFilename);
    const manifestPath = join(scopeDir, 'benchmark-dataset.manifest.json');
    const jsonl = scope.records.map((record) => JSON.stringify(record)).join('\n');
    const latestContents = jsonl ? `${jsonl}\n` : '';
    const gzipped = gzipSync(Buffer.from(latestContents, 'utf8'));

    await writeText(latestPath, latestContents);
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, gzipped);

    const manifest = buildScopeManifest(scope, {
      generatedAt: dataset.generatedAt,
      latestPath,
      snapshotPath,
      latestSha256: sha256(latestContents),
      snapshotSha256: sha256(gzipped),
      classification: dataset.classification,
    });
    await writeJson(manifestPath, manifest);

    scopeArtifacts.push({
      tenantId: scope.tenantId,
      useCase: scope.useCase,
      latestPath,
      snapshotPath,
      manifestPath,
      recordCount: scope.records.length,
    });
  }

  return {
    outputRootDir: absoluteOutputRootDir,
    summaryPath,
    annotationBatchPath,
    scopeArtifacts,
  };
}

function normalizePublicPipelineSuiteOutput(
  input: unknown,
  generatedAt: string,
): PublicDataPipelineSuiteOutput {
  const alreadyBuilt = publicDataPipelineSuiteOutputSchema.safeParse(input);
  if (alreadyBuilt.success) {
    return alreadyBuilt.data;
  }

  const suite = publicDataPipelineSuiteSchema.parse(input);
  return buildPublicDataPipelineSuite(suite, () => new Date(generatedAt));
}

function toReviewedRunExportRecord(
  record: PublicDataPipelineSuiteOutput['pipelines'][number]['records'][number],
  options: {
    packVersion: string;
    promptVersion: string;
    includeTranscript: boolean;
    reviewedAtFallback: string;
  },
): ReviewedRunExportRecord {
  const sample = record.reviewedSentimentSample;
  if (!sample) {
    throw new Error(`Missing reviewed sentiment sample for ${record.pipelineId}:${record.sourceRecordId}`);
  }

  const reviewedAt = sample.reviewedAt ?? options.reviewedAtFallback;
  const decision = mapReviewDecision(sample.analyst.reviewState ?? 'VERIFIED');
  const transcript = transcriptInputSchema.parse(record.transcript);

  return reviewedRunExportRecordSchema.parse({
    runId: sample.runId ?? `${record.pipelineId}:${record.sourceRecordId}`,
    tenantId: record.tenantId,
    useCase: record.useCase,
    engagementType: record.engagementType,
    queue: typeof transcript.metadata.queue === 'string' ? transcript.metadata.queue : undefined,
    transcriptTurnCount: typeof transcript.metadata.transcriptTurnCount === 'number'
      ? transcript.metadata.transcriptTurnCount
      : undefined,
    transcriptCharacterCount: typeof transcript.metadata.transcriptCharacterCount === 'number'
      ? transcript.metadata.transcriptCharacterCount
      : undefined,
    transcriptLengthBucket: typeof transcript.metadata.transcriptLengthBucket === 'string'
      ? transcript.metadata.transcriptLengthBucket
      : undefined,
    sourceDataset: sample.sourceDataset ?? record.dataset,
    datasetTrack: sample.datasetTrack ?? record.datasetTrack,
    conversationId: transcript.conversationId,
    createdAt: reviewedAt,
    updatedAt: reviewedAt,
    packVersion: options.packVersion,
    promptVersion: options.promptVersion,
    engine: 'rules',
    transcript: options.includeTranscript ? transcript : undefined,
    model: {
      polarity: sample.model.polarity,
      intensity: sample.model.intensity,
      confidence: sample.model.confidence,
      rationale: sample.model.rationale,
      score: {
        method: 'derived_v1',
        score100: sample.analyst.score100,
        score5: sample.analyst.score5 ?? deriveScore5FromScore100(sample.analyst.score100),
      },
    },
    review: {
      state: sample.analyst.reviewState ?? 'VERIFIED',
      decision,
      reviewedAt,
      reviewedById: sample.reviewedBy ?? 'public_annotator',
      reviewedByType: 'SYSTEM',
      analystSentiment: {
        score100: sample.analyst.score100,
        score5: sample.analyst.score5 ?? deriveScore5FromScore100(sample.analyst.score100),
        correctionApplied: sample.analyst.correctionApplied,
        note: sample.note,
        reviewedAt,
        reviewedById: sample.reviewedBy ?? 'public_annotator',
        reviewedByType: 'SYSTEM',
      },
      reasons: [],
    },
    piiRedactionSummary: {
      applied: false,
      redactionCount: 0,
      ruleHits: {},
    },
  });
}

function toBenchmarkAnnotationCandidate(
  record: PublicDataPipelineSuiteOutput['pipelines'][number]['records'][number],
): BenchmarkAnnotationCandidate {
  const transcript = transcriptInputSchema.parse(record.transcript);
  return benchmarkAnnotationCandidateSchema.parse({
    candidateId: `${record.pipelineId}:${record.sourceRecordId}`,
    pipelineId: record.pipelineId,
    sourceRecordId: record.sourceRecordId,
    tenantId: record.tenantId,
    useCase: record.useCase,
    sourceDataset: record.dataset,
    datasetTrack: record.datasetTrack,
    engagementType: record.engagementType,
    queue: typeof transcript.metadata.queue === 'string' ? transcript.metadata.queue : undefined,
    transcriptTurnCount: typeof transcript.metadata.transcriptTurnCount === 'number'
      ? transcript.metadata.transcriptTurnCount
      : 0,
    transcriptCharacterCount: typeof transcript.metadata.transcriptCharacterCount === 'number'
      ? transcript.metadata.transcriptCharacterCount
      : 0,
    transcriptLengthBucket: typeof transcript.metadata.transcriptLengthBucket === 'string'
      ? transcript.metadata.transcriptLengthBucket
      : 'SHORT',
    canonicalEventLabels: record.canonicalEventLabels,
    tags: record.tags,
    transcript,
    annotationTemplate: {
      reviewState: 'VERIFIED',
      correctionApplied: false,
    },
  });
}

function buildScopeManifest(
  scope: ReviewedBenchmarkScope,
  options: {
    generatedAt: string;
    latestPath: string;
    snapshotPath: string;
    latestSha256: string;
    snapshotSha256: string;
    classification: ReviewedRunExportManifest['classification'];
  },
): ReviewedRunExportManifest {
  const byEngagementType: Record<string, number> = {};
  const byQueue: Record<string, number> = {};
  const byTranscriptLengthBucket: Record<string, number> = {};
  let latestReviewedAt: string | undefined;
  let latestUpdatedAt: string | undefined;
  let analystSentimentCount = 0;

  for (const record of scope.records) {
    if (record.engagementType) {
      byEngagementType[record.engagementType] = (byEngagementType[record.engagementType] ?? 0) + 1;
    }
    if (record.queue) {
      byQueue[record.queue] = (byQueue[record.queue] ?? 0) + 1;
    }
    if (record.transcriptLengthBucket) {
      byTranscriptLengthBucket[record.transcriptLengthBucket] = (byTranscriptLengthBucket[record.transcriptLengthBucket] ?? 0) + 1;
    }
    if (record.review.analystSentiment) {
      analystSentimentCount += 1;
    }
    if (record.review.reviewedAt && (!latestReviewedAt || record.review.reviewedAt > latestReviewedAt)) {
      latestReviewedAt = record.review.reviewedAt;
    }
    if (!latestUpdatedAt || record.updatedAt > latestUpdatedAt) {
      latestUpdatedAt = record.updatedAt;
    }
  }

  return reviewedRunExportManifestSchema.parse({
    tenantId: scope.tenantId,
    useCase: scope.useCase,
    generatedAt: options.generatedAt,
    exportedCount: scope.records.length,
    analystSentimentCount,
    latestPath: options.latestPath,
    latestSha256: options.latestSha256,
    snapshotPath: options.snapshotPath,
    snapshotSha256: options.snapshotSha256,
    byEngagementType,
    byQueue,
    byTranscriptLengthBucket,
    latestReviewedAt,
    latestUpdatedAt,
    includeTranscript: true,
    requireAnalystSentiment: true,
    classification: options.classification,
    coverageFailures: [],
  });
}

function getOrCreateScope(
  scopesByKey: Map<string, ReviewedBenchmarkScope>,
  tenantId: string,
  useCase: string,
): ReviewedBenchmarkScope {
  const key = `${tenantId}::${useCase}`;
  let scope = scopesByKey.get(key);
  if (!scope) {
    scope = { tenantId, useCase, records: [] };
    scopesByKey.set(key, scope);
  }
  return scope;
}

function mapReviewDecision(reviewState: 'VERIFIED' | 'UNCERTAIN' | 'NEEDS_REVIEW'): z.infer<typeof benchmarkReviewDecisionSchema> {
  if (reviewState === 'UNCERTAIN') {
    return 'MARK_UNCERTAIN';
  }
  if (reviewState === 'NEEDS_REVIEW') {
    return 'KEEP_NEEDS_REVIEW';
  }
  return 'VERIFY';
}

function summarizeAnnotationCandidates(
  candidates: BenchmarkAnnotationCandidate[],
  selector: (candidate: BenchmarkAnnotationCandidate) => string,
): Record<string, number> {
  return candidates.reduce<Record<string, number>>((aggregate, candidate) => {
    const key = selector(candidate);
    aggregate[key] = (aggregate[key] ?? 0) + 1;
    return aggregate;
  }, {});
}

function sanitizeTimestamp(input: string): string {
  return input.replace(/[:.]/g, '-');
}

function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  const parsedRows = rows.map((row) => JSON.stringify(row)).join('\n');
  await writeText(path, parsedRows ? `${parsedRows}\n` : '');
}

async function writeText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}
