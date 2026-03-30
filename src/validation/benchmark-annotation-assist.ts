import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { z } from 'zod';
import {
  overallSentimentSchema,
  tenantPackSchema,
  TranscriptInput,
  transcriptInputSchema,
} from '../contracts';
import { analyzeConversation } from '../pipeline/analyze-conversation';
import type { CanonicalAnalysisEngine } from '../rlm/engine';
import {
  BenchmarkAnnotationCandidate,
  benchmarkAnnotationCandidateSchema,
  benchmarkAnnotationTemplateSchema,
} from './reviewed-benchmark-dataset';

const reviewStateSchema = z.enum(['VERIFIED', 'UNCERTAIN', 'NEEDS_REVIEW']);
const draftAnnotationStatusSchema = z.enum(['DRAFTED', 'FAILED']);

export const benchmarkAnnotationDraftTrialSchema = z.object({
  trial: z.number().int().min(1),
  status: z.enum(['COMPLETED', 'FAILED']),
  durationMs: z.number().int().min(0),
  reviewState: reviewStateSchema.optional(),
  reviewReasons: z.array(z.string()).default([]),
  sentiment: overallSentimentSchema.nullable().optional(),
  summary: z.string().min(1).optional(),
  trace: z.object({
    engine: z.enum(['rlm', 'rules']),
    model: z.string().min(1).optional(),
    promptVersion: z.string().min(1),
    packVersion: z.string().min(1),
    generatedAt: z.string().min(1),
  }).optional(),
  errorMessage: z.string().min(1).optional(),
});

export type BenchmarkAnnotationDraftTrial = z.infer<typeof benchmarkAnnotationDraftTrialSchema>;

export const benchmarkAnnotationDraftSuggestionSchema = benchmarkAnnotationTemplateSchema.extend({
  confidence: z.number().min(0).max(1).optional(),
  sourceModel: z.string().min(1).optional(),
  sourceEngine: z.enum(['rlm', 'rules']).optional(),
  sourcePackVersion: z.string().min(1).optional(),
  sourcePromptVersion: z.string().min(1).optional(),
  completedTrials: z.number().int().min(0),
  failedTrials: z.number().int().min(0),
  scoreSpread100: z.number().int().min(0).max(100).optional(),
  reviewStateCounts: z.record(z.string(), z.number().int().min(0)).default({}),
});

export type BenchmarkAnnotationDraftSuggestion = z.infer<typeof benchmarkAnnotationDraftSuggestionSchema>;

export const benchmarkAnnotationDraftRecordSchema = z.object({
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
  transcriptLengthBucket: z.enum(['SHORT', 'MEDIUM', 'LONG', 'VERY_LONG']),
  status: draftAnnotationStatusSchema,
  draftOnly: z.literal(true),
  priorityReview: z.boolean(),
  priorityReviewReasons: z.array(z.string()).default([]),
  suggestedAnnotation: benchmarkAnnotationDraftSuggestionSchema.optional(),
  transcriptPreview: z.string().min(1),
  trials: z.array(benchmarkAnnotationDraftTrialSchema),
  generatedAt: z.string().min(1),
  errorMessage: z.string().min(1).optional(),
});

export type BenchmarkAnnotationDraftRecord = z.infer<typeof benchmarkAnnotationDraftRecordSchema>;

export const benchmarkAnnotationDraftSummarySchema = z.object({
  generatedAt: z.string().min(1),
  candidateCount: z.number().int().min(0),
  draftedCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  priorityReviewCount: z.number().int().min(0),
  byEngagementType: z.record(z.string(), z.number().int().min(0)).default({}),
  byStatus: z.record(z.string(), z.number().int().min(0)).default({}),
  bySuggestedReviewState: z.record(z.string(), z.number().int().min(0)).default({}),
  byQueue: z.record(z.string(), z.number().int().min(0)).default({}),
  scoreStats: z.object({
    averageScore100: z.number().min(0).max(100).optional(),
    minScore100: z.number().int().min(0).max(100).optional(),
    maxScore100: z.number().int().min(0).max(100).optional(),
  }),
});

export type BenchmarkAnnotationDraftSummary = z.infer<typeof benchmarkAnnotationDraftSummarySchema>;

export const benchmarkAnnotationDraftReportSchema = z.object({
  generatedAt: z.string().min(1),
  sourcePath: z.string().min(1),
  tenantPackPathsByUseCase: z.record(z.string(), z.string()).default({}),
  defaultTenantPackPath: z.string().min(1).optional(),
  trialsPerCandidate: z.number().int().min(1),
  records: z.array(benchmarkAnnotationDraftRecordSchema),
  summary: benchmarkAnnotationDraftSummarySchema,
});

export type BenchmarkAnnotationDraftReport = z.infer<typeof benchmarkAnnotationDraftReportSchema>;

export interface GenerateBenchmarkAnnotationDraftsOptions {
  engine: CanonicalAnalysisEngine;
  resolveTenantPack: (candidate: BenchmarkAnnotationCandidate) => unknown | Promise<unknown>;
  sourcePath?: string;
  defaultTenantPackPath?: string;
  tenantPackPathsByUseCase?: Record<string, string>;
  trialsPerCandidate?: number;
  concurrency?: number;
  perRecordTimeoutMs?: number;
  now?: () => Date;
}

export interface BenchmarkAnnotationDraftArtifacts {
  outputDir: string;
  summaryPath: string;
  reportPath: string;
  draftsPath: string;
  markdownPath: string;
}

export async function loadBenchmarkAnnotationCandidates(path: string): Promise<BenchmarkAnnotationCandidate[]> {
  const absolutePath = resolve(path);
  const raw = await readFile(absolutePath, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    return z.array(benchmarkAnnotationCandidateSchema).parse(JSON.parse(trimmed));
  }

  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => benchmarkAnnotationCandidateSchema.parse(JSON.parse(line)));
}

export async function generateBenchmarkAnnotationDraftReport(
  candidates: BenchmarkAnnotationCandidate[],
  options: GenerateBenchmarkAnnotationDraftsOptions,
): Promise<BenchmarkAnnotationDraftReport> {
  const now = options.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const trialsPerCandidate = Math.max(1, options.trialsPerCandidate ?? 1);
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const records = await mapWithConcurrency(candidates, concurrency, async (candidate) => {
    const pack = tenantPackSchema.parse(await options.resolveTenantPack(candidate));
    return annotateCandidate(candidate, pack, {
      engine: options.engine,
      now,
      perRecordTimeoutMs: options.perRecordTimeoutMs,
      trialsPerCandidate,
      generatedAt,
    });
  });

  return benchmarkAnnotationDraftReportSchema.parse({
    generatedAt,
    sourcePath: options.sourcePath ?? 'unknown',
    tenantPackPathsByUseCase: options.tenantPackPathsByUseCase ?? {},
    defaultTenantPackPath: options.defaultTenantPackPath,
    trialsPerCandidate,
    records,
    summary: summarizeDraftRecords(records, generatedAt),
  });
}

export async function writeBenchmarkAnnotationDraftArtifacts(
  outputDir: string,
  report: BenchmarkAnnotationDraftReport,
): Promise<BenchmarkAnnotationDraftArtifacts> {
  const absoluteOutputDir = resolve(outputDir);
  const reportPath = join(absoluteOutputDir, 'draft-annotation-report.json');
  const summaryPath = join(absoluteOutputDir, 'draft-annotation-summary.json');
  const draftsPath = join(absoluteOutputDir, 'draft-annotations.jsonl');
  const markdownPath = join(absoluteOutputDir, 'draft-annotation-review.md');

  await writeJson(reportPath, report);
  await writeJson(summaryPath, report.summary);
  await writeText(draftsPath, report.records.map((record) => JSON.stringify(record)).join('\n'));
  await writeText(markdownPath, renderDraftAnnotationReviewMarkdown(report));

  return {
    outputDir: absoluteOutputDir,
    summaryPath,
    reportPath,
    draftsPath,
    markdownPath,
  };
}

async function annotateCandidate(
  candidate: BenchmarkAnnotationCandidate,
  tenantPack: z.infer<typeof tenantPackSchema>,
  options: {
    engine: CanonicalAnalysisEngine;
    now: () => Date;
    generatedAt: string;
    trialsPerCandidate: number;
    perRecordTimeoutMs?: number;
  },
): Promise<BenchmarkAnnotationDraftRecord> {
  const trials: BenchmarkAnnotationDraftTrial[] = [];

  for (let index = 0; index < options.trialsPerCandidate; index += 1) {
    trials.push(await runCandidateTrial(candidate.transcript, tenantPack, index + 1, options));
  }

  const completedTrials = trials.filter((trial) => trial.status === 'COMPLETED');
  const failedTrials = trials.length - completedTrials.length;
  const preview = buildTranscriptPreview(candidate.transcript);

  if (completedTrials.length === 0) {
    return benchmarkAnnotationDraftRecordSchema.parse({
      candidateId: candidate.candidateId,
      pipelineId: candidate.pipelineId,
      sourceRecordId: candidate.sourceRecordId,
      tenantId: candidate.tenantId,
      useCase: candidate.useCase,
      sourceDataset: candidate.sourceDataset,
      datasetTrack: candidate.datasetTrack,
      engagementType: candidate.engagementType,
      queue: candidate.queue,
      transcriptTurnCount: candidate.transcriptTurnCount,
      transcriptCharacterCount: candidate.transcriptCharacterCount,
      transcriptLengthBucket: candidate.transcriptLengthBucket,
      status: 'FAILED',
      draftOnly: true,
      priorityReview: true,
      priorityReviewReasons: ['all_trials_failed'],
      transcriptPreview: preview,
      trials,
      generatedAt: options.generatedAt,
      errorMessage: trials.map((trial) => trial.errorMessage).filter(Boolean).join(' | ') || 'All annotation trials failed.',
    });
  }

  const aggregatedReviewState = resolveAggregatedReviewState(completedTrials);
  const scoredTrials = completedTrials.filter((trial) => typeof trial.sentiment?.score?.score100 === 'number');
  const scoreValues = scoredTrials
    .map((trial) => trial.sentiment?.score?.score100)
    .filter((value): value is number => typeof value === 'number')
    .sort((left, right) => left - right);
  const medianScore100 = scoreValues.length > 0 ? median(scoreValues) : undefined;
  const selectedTrial = selectRepresentativeTrial(completedTrials, aggregatedReviewState, medianScore100);
  const selectedSentiment = selectedTrial?.sentiment ?? null;
  const scoreSpread100 = scoreValues.length > 1
    ? (scoreValues[scoreValues.length - 1] ?? 0) - (scoreValues[0] ?? 0)
    : undefined;
  const reviewStateCounts = countValues(completedTrials.map((trial) => trial.reviewState ?? 'UNKNOWN'));
  const priorityReviewReasons = buildPriorityReviewReasons({
    aggregatedReviewState,
    completedTrials,
    failedTrials,
    scoreSpread100,
    selectedTrial,
  });
  const suggestedAnnotation = selectedSentiment
    ? benchmarkAnnotationDraftSuggestionSchema.parse({
      ...candidate.annotationTemplate,
      polarity: selectedSentiment.polarity,
      intensity: selectedSentiment.intensity,
      confidence: selectedSentiment.confidence,
      score100: selectedSentiment.score?.score100,
      score5: selectedSentiment.score?.score5,
      reviewState: aggregatedReviewState,
      correctionApplied: false,
      rationale: selectedSentiment.rationale,
      note: buildSuggestionNote({
        candidate,
        selectedTrial,
        completedTrials: completedTrials.length,
        failedTrials,
        scoreSpread100,
        priorityReviewReasons,
      }),
      sourceModel: selectedTrial?.trace?.model,
      sourceEngine: selectedTrial?.trace?.engine,
      sourcePackVersion: selectedTrial?.trace?.packVersion,
      sourcePromptVersion: selectedTrial?.trace?.promptVersion,
      completedTrials: completedTrials.length,
      failedTrials,
      scoreSpread100,
      reviewStateCounts,
    })
    : undefined;

  return benchmarkAnnotationDraftRecordSchema.parse({
    candidateId: candidate.candidateId,
    pipelineId: candidate.pipelineId,
    sourceRecordId: candidate.sourceRecordId,
    tenantId: candidate.tenantId,
    useCase: candidate.useCase,
    sourceDataset: candidate.sourceDataset,
    datasetTrack: candidate.datasetTrack,
    engagementType: candidate.engagementType,
    queue: candidate.queue,
    transcriptTurnCount: candidate.transcriptTurnCount,
    transcriptCharacterCount: candidate.transcriptCharacterCount,
    transcriptLengthBucket: candidate.transcriptLengthBucket,
    status: suggestedAnnotation ? 'DRAFTED' : 'FAILED',
    draftOnly: true,
    priorityReview: priorityReviewReasons.length > 0,
    priorityReviewReasons,
    suggestedAnnotation,
    transcriptPreview: preview,
    trials,
    generatedAt: options.generatedAt,
    errorMessage: suggestedAnnotation ? undefined : 'Completed trials did not return usable sentiment output.',
  });
}

async function runCandidateTrial(
  transcriptInput: TranscriptInput,
  tenantPack: z.infer<typeof tenantPackSchema>,
  trial: number,
  options: {
    engine: CanonicalAnalysisEngine;
    now: () => Date;
    perRecordTimeoutMs?: number;
  },
): Promise<BenchmarkAnnotationDraftTrial> {
  const startedAt = Date.now();
  const timeoutController = typeof options.perRecordTimeoutMs === 'number' && options.perRecordTimeoutMs > 0
    ? new AbortController()
    : null;
  const timeoutHandle = timeoutController
    ? setTimeout(() => timeoutController.abort(new Error(`Annotation trial timed out after ${options.perRecordTimeoutMs}ms`)), options.perRecordTimeoutMs)
    : undefined;

  try {
    const analysis = await analyzeConversation(transcriptInput, tenantPack, {
      engine: options.engine,
      now: options.now(),
      signal: timeoutController?.signal,
    });
    return benchmarkAnnotationDraftTrialSchema.parse({
      trial,
      status: 'COMPLETED',
      durationMs: Date.now() - startedAt,
      reviewState: analysis.review.state,
      reviewReasons: analysis.review.reasons,
      sentiment: analysis.overallEndUserSentiment,
      summary: analysis.summary,
      trace: analysis.trace,
    });
  } catch (error) {
    return benchmarkAnnotationDraftTrialSchema.parse({
      trial,
      status: 'FAILED',
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function resolveAggregatedReviewState(
  completedTrials: BenchmarkAnnotationDraftTrial[],
): z.infer<typeof reviewStateSchema> {
  const counts = countValues(completedTrials.map((trial) => trial.reviewState ?? 'VERIFIED'));
  const priority: Record<z.infer<typeof reviewStateSchema>, number> = {
    NEEDS_REVIEW: 3,
    UNCERTAIN: 2,
    VERIFIED: 1,
  };

  return (Object.entries(counts)
    .filter(([key]) => key === 'VERIFIED' || key === 'UNCERTAIN' || key === 'NEEDS_REVIEW')
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return priority[right[0] as z.infer<typeof reviewStateSchema>] - priority[left[0] as z.infer<typeof reviewStateSchema>];
    })[0]?.[0] ?? 'VERIFIED') as z.infer<typeof reviewStateSchema>;
}

function selectRepresentativeTrial(
  completedTrials: BenchmarkAnnotationDraftTrial[],
  reviewState: z.infer<typeof reviewStateSchema>,
  score100: number | undefined,
): BenchmarkAnnotationDraftTrial | undefined {
  const matchingState = completedTrials.filter((trial) => trial.reviewState === reviewState);
  const pool = matchingState.length > 0 ? matchingState : completedTrials;
  if (typeof score100 !== 'number') {
    return pool[0];
  }

  return pool
    .filter((trial) => typeof trial.sentiment?.score?.score100 === 'number')
    .sort((left, right) => {
      const leftDelta = Math.abs((left.sentiment?.score?.score100 ?? score100) - score100);
      const rightDelta = Math.abs((right.sentiment?.score?.score100 ?? score100) - score100);
      if (leftDelta !== rightDelta) {
        return leftDelta - rightDelta;
      }
      return (right.sentiment?.confidence ?? 0) - (left.sentiment?.confidence ?? 0);
    })[0] ?? pool[0];
}

function buildPriorityReviewReasons(input: {
  aggregatedReviewState: z.infer<typeof reviewStateSchema>;
  completedTrials: BenchmarkAnnotationDraftTrial[];
  failedTrials: number;
  scoreSpread100: number | undefined;
  selectedTrial: BenchmarkAnnotationDraftTrial | undefined;
}): string[] {
  const reasons: string[] = [];
  const distinctStates = new Set(input.completedTrials.map((trial) => trial.reviewState));
  if (input.failedTrials > 0) {
    reasons.push('trial_failures_present');
  }
  if (distinctStates.size > 1) {
    reasons.push('review_state_disagreement');
  }
  if (typeof input.scoreSpread100 === 'number' && input.scoreSpread100 > 8) {
    reasons.push('score_spread_gt_8');
  }
  if (input.aggregatedReviewState !== 'VERIFIED') {
    reasons.push(`model_requested_${input.aggregatedReviewState.toLowerCase()}`);
  }
  if ((input.selectedTrial?.sentiment?.confidence ?? 1) < 0.7) {
    reasons.push('low_model_confidence');
  }
  if (!input.selectedTrial?.sentiment?.score) {
    reasons.push('missing_sentiment_score');
  }
  return reasons;
}

function buildSuggestionNote(input: {
  candidate: BenchmarkAnnotationCandidate;
  selectedTrial: BenchmarkAnnotationDraftTrial | undefined;
  completedTrials: number;
  failedTrials: number;
  scoreSpread100: number | undefined;
  priorityReviewReasons: string[];
}): string {
  const parts = [
    `System-generated draft annotation for ${input.candidate.candidateId}.`,
    `Completed ${input.completedTrials} trial(s)${input.failedTrials > 0 ? ` with ${input.failedTrials} failure(s)` : ''}.`,
  ];
  if (typeof input.scoreSpread100 === 'number') {
    parts.push(`score spread=${input.scoreSpread100}.`);
  }
  if (input.priorityReviewReasons.length > 0) {
    parts.push(`Priority review: ${input.priorityReviewReasons.join(', ')}.`);
  }
  if (input.selectedTrial?.summary) {
    parts.push(`Representative summary: ${input.selectedTrial.summary}`);
  }
  return parts.join(' ');
}

function summarizeDraftRecords(
  records: BenchmarkAnnotationDraftRecord[],
  generatedAt: string,
): BenchmarkAnnotationDraftSummary {
  const drafted = records.filter((record) => record.status === 'DRAFTED');
  const scoreValues = drafted
    .map((record) => record.suggestedAnnotation?.score100)
    .filter((value): value is number => typeof value === 'number');
  const byEngagementType = countValues(records.map((record) => record.engagementType));
  const byStatus = countValues(records.map((record) => record.status));
  const bySuggestedReviewState = countValues(
    drafted
      .map((record) => record.suggestedAnnotation?.reviewState)
      .filter((value): value is NonNullable<typeof value> => typeof value === 'string'),
  );
  const byQueue = countValues(
    records.map((record) => record.queue ?? 'UNSPECIFIED'),
  );

  return benchmarkAnnotationDraftSummarySchema.parse({
    generatedAt,
    candidateCount: records.length,
    draftedCount: drafted.length,
    failedCount: records.length - drafted.length,
    priorityReviewCount: records.filter((record) => record.priorityReview).length,
    byEngagementType,
    byStatus,
    bySuggestedReviewState,
    byQueue,
    scoreStats: scoreValues.length > 0
      ? {
        averageScore100: Number((scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length).toFixed(2)),
        minScore100: Math.min(...scoreValues),
        maxScore100: Math.max(...scoreValues),
      }
      : {},
  });
}

function renderDraftAnnotationReviewMarkdown(report: BenchmarkAnnotationDraftReport): string {
  const lines: string[] = [
    '# Draft Annotation Review Batch',
    '',
    `Generated at: ${report.generatedAt}`,
    '',
    'These labels are system-generated drafts. They are not gold benchmark labels until a human reviewer accepts or corrects them.',
    '',
    '## Summary',
    '',
    `- candidates: ${report.summary.candidateCount}`,
    `- drafted: ${report.summary.draftedCount}`,
    `- failed: ${report.summary.failedCount}`,
    `- priority review: ${report.summary.priorityReviewCount}`,
    '',
    '## Candidate Review Order',
    '',
  ];

  const ordered = [...report.records].sort((left, right) => {
    if (left.priorityReview !== right.priorityReview) {
      return left.priorityReview ? -1 : 1;
    }
    return left.candidateId.localeCompare(right.candidateId);
  });

  for (const record of ordered) {
    lines.push(`### ${record.candidateId}`);
    lines.push('');
    lines.push(`- status: ${record.status}`);
    lines.push(`- engagement: ${record.engagementType}`);
    lines.push(`- queue: ${record.queue ?? 'UNSPECIFIED'}`);
    if (record.suggestedAnnotation) {
      lines.push(`- suggested score100/score5: ${record.suggestedAnnotation.score100 ?? 'n/a'} / ${record.suggestedAnnotation.score5 ?? 'n/a'}`);
      lines.push(`- suggested review state: ${record.suggestedAnnotation.reviewState}`);
      lines.push(`- model: ${record.suggestedAnnotation.sourceModel ?? record.suggestedAnnotation.sourceEngine ?? 'unknown'}`);
    }
    lines.push(`- priority review: ${record.priorityReview ? 'yes' : 'no'}${record.priorityReviewReasons.length > 0 ? ` (${record.priorityReviewReasons.join(', ')})` : ''}`);
    lines.push(`- transcript preview: ${record.transcriptPreview}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function buildTranscriptPreview(transcriptInput: TranscriptInput): string {
  const transcript = transcriptInputSchema.parse(transcriptInput);
  const snippet = transcript.turns
    .slice(0, 4)
    .map((turn) => `${turn.speakerId}: ${turn.text.replace(/\s+/g, ' ').trim()}`)
    .join(' | ');
  return snippet.slice(0, 400);
}

function countValues(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((aggregate, value) => {
    aggregate[value] = (aggregate[value] ?? 0) + 1;
    return aggregate;
  }, {});
}

function median(values: number[]): number {
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) {
    return values[middle] ?? 0;
  }
  const left = values[middle - 1] ?? 0;
  const right = values[middle] ?? left;
  return Math.round((left + right) / 2);
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value ? `${value.replace(/\n?$/, '')}\n` : '', 'utf8');
}
