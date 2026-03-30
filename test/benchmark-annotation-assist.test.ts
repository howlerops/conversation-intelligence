import { readFileSync } from 'fs';
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';
import {
  canonicalExtractionSchema,
  generateBenchmarkAnnotationDraftReport,
  loadBenchmarkAnnotationCandidates,
  writeBenchmarkAnnotationDraftArtifacts,
} from '../src';
import type { CanonicalAnalysisEngine } from '../src/rlm/engine';
import { benchmarkAnnotationCandidateSchema } from '../src/validation/reviewed-benchmark-dataset';

const transcript = JSON.parse(readFileSync(resolve('fixtures/transcript.support.basic.json'), 'utf8'));
const tenantPack = JSON.parse(readFileSync(resolve('fixtures/tenant-pack.support.acme.json'), 'utf8'));

function buildCandidate(candidateId: string) {
  return benchmarkAnnotationCandidateSchema.parse({
    candidateId,
    pipelineId: 'support-benchmark',
    sourceRecordId: candidateId,
    tenantId: 'tenant_acme',
    useCase: 'support',
    sourceDataset: 'TASKMASTER',
    datasetTrack: 'OPEN_CORE',
    engagementType: 'CALL',
    queue: 'support_voice',
    transcriptTurnCount: transcript.turns.length,
    transcriptCharacterCount: transcript.turns.reduce((sum: number, turn: { text: string }) => sum + turn.text.length, 0),
    transcriptLengthBucket: 'SHORT',
    canonicalEventLabels: [],
    tags: ['support'],
    transcript,
    annotationTemplate: {
      reviewState: 'VERIFIED',
      correctionApplied: false,
    },
  });
}

function createSequenceEngine(scoreSequence: number[], reviewStates: Array<'VERIFIED' | 'UNCERTAIN' | 'NEEDS_REVIEW'>): CanonicalAnalysisEngine {
  let index = 0;
  return {
    async analyze() {
      const score100 = scoreSequence[Math.min(index, scoreSequence.length - 1)] ?? 50;
      const reviewState = reviewStates[Math.min(index, reviewStates.length - 1)] ?? 'VERIFIED';
      index += 1;
      return {
        engine: 'rlm',
        model: 'test-model',
        extraction: canonicalExtractionSchema.parse({
          overallEndUserSentiment: {
            polarity: score100 <= 20
              ? 'VERY_NEGATIVE'
              : score100 <= 40
                ? 'NEGATIVE'
                : score100 <= 60
                  ? 'NEUTRAL'
                  : score100 <= 80
                    ? 'POSITIVE'
                    : 'VERY_POSITIVE',
            intensity: 0.7,
            confidence: 0.82,
            rationale: `score=${score100}`,
            score: {
              method: 'model_v1',
              score100,
              score5: Math.min(5, Math.floor(Math.max(score100 - 1, 0) / 20) + 1),
            },
          },
          aspectSentiments: [],
          canonicalEvents: [],
          canonicalKeyMoments: [],
          summary: `summary-${score100}`,
          review: {
            state: reviewState,
            reasons: reviewState === 'VERIFIED' ? [] : ['needs_manual_attention'],
            comments: [],
            history: [],
          },
        }),
      };
    },
  } satisfies CanonicalAnalysisEngine;
}

describe('benchmark annotation assist', () => {
  it('loads JSONL candidate batches', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'conversation-intelligence-annotation-candidates-'));
    const path = join(outputDir, 'annotation-candidates.jsonl');
    const first = buildCandidate('candidate-1');
    const second = buildCandidate('candidate-2');
    await writeFile(path, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, 'utf8');

    const loaded = await loadBenchmarkAnnotationCandidates(path);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.candidateId).toBe('candidate-1');
    expect(loaded[1]?.candidateId).toBe('candidate-2');
  });

  it('aggregates multi-trial draft annotations and flags disagreement', async () => {
    const candidate = buildCandidate('candidate-aggregate');
    const report = await generateBenchmarkAnnotationDraftReport([candidate], {
      engine: createSequenceEngine([48, 52, 70], ['VERIFIED', 'VERIFIED', 'NEEDS_REVIEW']),
      resolveTenantPack: async () => tenantPack,
      sourcePath: '/tmp/annotation-candidates.jsonl',
      defaultTenantPackPath: resolve('fixtures/tenant-pack.support.acme.json'),
      trialsPerCandidate: 3,
      now: () => new Date('2026-03-29T18:00:00.000Z'),
    });

    expect(report.summary.candidateCount).toBe(1);
    expect(report.summary.draftedCount).toBe(1);
    expect(report.summary.priorityReviewCount).toBe(1);
    expect(report.records[0]?.suggestedAnnotation?.score100).toBe(52);
    expect(report.records[0]?.suggestedAnnotation?.reviewState).toBe('VERIFIED');
    expect(report.records[0]?.priorityReviewReasons).toContain('review_state_disagreement');
    expect(report.records[0]?.priorityReviewReasons).toContain('score_spread_gt_8');
  });

  it('writes JSON and markdown artifacts', async () => {
    const candidate = buildCandidate('candidate-write');
    const report = await generateBenchmarkAnnotationDraftReport([candidate], {
      engine: createSequenceEngine([30], ['UNCERTAIN']),
      resolveTenantPack: async () => tenantPack,
      sourcePath: '/tmp/annotation-candidates.jsonl',
      trialsPerCandidate: 1,
      now: () => new Date('2026-03-29T18:30:00.000Z'),
    });
    const outputDir = await mkdtemp(join(tmpdir(), 'conversation-intelligence-draft-annotations-'));
    const artifacts = await writeBenchmarkAnnotationDraftArtifacts(outputDir, report);
    const summary = JSON.parse(await readFile(artifacts.summaryPath, 'utf8'));
    const markdown = await readFile(artifacts.markdownPath, 'utf8');
    const drafts = (await readFile(artifacts.draftsPath, 'utf8')).trim().split(/\r?\n/);

    expect(summary.priorityReviewCount).toBe(1);
    expect(markdown).toContain('candidate-write');
    expect(markdown).toContain('model_requested_needs_review');
    expect(drafts).toHaveLength(1);
  });
});
