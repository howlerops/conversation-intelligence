import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadReviewedExportDataset,
  summarizeReviewedExportDataset,
} from '../src';

function buildReviewedExportRecord(input: {
  runId: string;
  updatedAt: string;
  score100: number;
  includeTranscript?: boolean;
  includeAnalystSentiment?: boolean;
}) {
  const score5 = Math.min(5, Math.floor(Math.max(input.score100 - 1, 0) / 20) + 1);
  return {
    runId: input.runId,
    tenantId: 'tenant_acme',
    useCase: 'support',
    engagementType: 'EMAIL',
    queue: 'support_email',
    transcriptTurnCount: 2,
    transcriptCharacterCount: 48,
    transcriptLengthBucket: 'SHORT',
    createdAt: '2026-03-28T00:00:00.000Z',
    updatedAt: input.updatedAt,
    packVersion: 'support-v1',
    promptVersion: 'test-prompt',
    engine: 'rlm',
    transcript: input.includeTranscript === false
      ? undefined
      : {
        tenantId: 'tenant_acme',
        conversationId: `${input.runId}_conversation`,
        useCase: 'support',
        participants: [
          { speakerId: 'customer', displayName: 'Customer', metadata: { kind: 'customer' } },
          { speakerId: 'agent', displayName: 'Agent', metadata: { kind: 'agent' } },
        ],
        turns: [
          { turnId: 't1', speakerId: 'customer', text: 'Need a refund.', metadata: { engagementType: 'EMAIL', queue: 'support_email' } },
          { turnId: 't2', speakerId: 'agent', text: 'Working on it.' },
        ],
        metadata: {
          engagementType: 'EMAIL',
          queue: 'support_email',
        },
      },
    model: {
      polarity: input.score100 < 50 ? 'NEGATIVE' : 'POSITIVE',
      intensity: 0.4,
      confidence: 0.85,
      rationale: 'Synthetic export record.',
      score: {
        method: 'derived_v1',
        score100: input.score100,
        score5,
      },
    },
    review: {
      state: 'VERIFIED',
      analystSentiment: input.includeAnalystSentiment === false
        ? undefined
        : {
          score100: input.score100,
          score5,
          correctionApplied: false,
          reviewedAt: input.updatedAt,
          reviewedById: 'analyst_1',
          reviewedByType: 'USER',
        },
      reasons: [],
    },
  };
}

describe('reviewed export dataset utilities', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('deduplicates repeated run ids across latest and snapshot trees', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-reviewed-export-dataset-'));
    tempDirs.push(rootDir);

    await mkdir(join(rootDir, 'tenant_acme'), { recursive: true });
    await mkdir(join(rootDir, 'snapshots', 'tenant_acme', 'support'), { recursive: true });
    await writeFile(join(rootDir, 'tenant_acme', 'support.jsonl'), [
      JSON.stringify(buildReviewedExportRecord({
        runId: 'run-001',
        updatedAt: '2026-03-28T10:00:00.000Z',
        score100: 62,
      })),
      JSON.stringify(buildReviewedExportRecord({
        runId: 'run-002',
        updatedAt: '2026-03-28T11:00:00.000Z',
        score100: 25,
      })),
    ].join('\n'));
    await writeFile(
      join(rootDir, 'snapshots', 'tenant_acme', 'support', '2026-03-27T09-00-00-000Z.jsonl'),
      `${JSON.stringify(buildReviewedExportRecord({
        runId: 'run-001',
        updatedAt: '2026-03-27T09:00:00.000Z',
        score100: 40,
      }))}\n`,
    );
    await writeFile(join(rootDir, 'summary.json'), JSON.stringify({ ignored: true }, null, 2));

    const records = await loadReviewedExportDataset(rootDir, {
      requireAnalystSentiment: true,
      requireTranscript: true,
    });
    const summary = await summarizeReviewedExportDataset(rootDir, {
      requireAnalystSentiment: true,
    });

    expect(records).toHaveLength(2);
    expect(records[0]?.runId).toBe('run-001');
    expect(records[0]?.model?.score?.score100).toBe(62);
    expect(summary.recordCount).toBe(2);
    expect(summary.transcriptRecordCount).toBe(2);
    expect(summary.analystSentimentCount).toBe(2);
    expect(summary.byEngagementType.EMAIL).toBe(2);
  });

  it('filters out records without transcripts or analyst sentiment when required', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-reviewed-export-filter-'));
    tempDirs.push(rootDir);

    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, 'support.jsonl'), [
      JSON.stringify(buildReviewedExportRecord({
        runId: 'run-has-everything',
        updatedAt: '2026-03-28T10:00:00.000Z',
        score100: 55,
      })),
      JSON.stringify(buildReviewedExportRecord({
        runId: 'run-no-transcript',
        updatedAt: '2026-03-28T11:00:00.000Z',
        score100: 44,
        includeTranscript: false,
      })),
      JSON.stringify(buildReviewedExportRecord({
        runId: 'run-no-analyst',
        updatedAt: '2026-03-28T12:00:00.000Z',
        score100: 30,
        includeAnalystSentiment: false,
      })),
    ].join('\n'));

    const records = await loadReviewedExportDataset(rootDir, {
      requireTranscript: true,
      requireAnalystSentiment: true,
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.runId).toBe('run-has-everything');
  });
});
