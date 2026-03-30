import { mkdtemp, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildReviewedBenchmarkDataset,
  buildPublicScalePipelineSuite,
  writeReviewedBenchmarkDataset,
} from '../src';

const taskmasterDialogs = {
  self: [
    {
      conversation_id: 'self-001',
      instruction_id: 'support-self-001',
      utterances: [
        { speaker: 'USER', text: 'The refund still has not posted and I already called twice.' },
        { speaker: 'ASSISTANT', text: 'I can escalate the refund issue to billing right now.' },
        { speaker: 'USER', text: 'Please do that because month-end is blocked.' },
        { speaker: 'ASSISTANT', text: 'I will send the written update as soon as billing confirms.' },
      ],
    },
  ],
  woz: [],
};

const abcdDataset = {
  train: [
    {
      convo_id: 1,
      scenario: {
        flow: 'refund',
        subflow: 'delay',
      },
      original: [
        ['agent', 'Thanks for contacting support.'] as [string, string],
        ['customer', 'The refund was promised for Monday and it still is not there.'] as [string, string],
        ['agent', 'I can see the pending refund and I am escalating it now.'] as [string, string],
        ['customer', 'Please send me the update because finance needs it today.'] as [string, string],
      ],
    },
  ],
  dev: [],
  test: [],
};

describe('reviewed benchmark dataset builders', () => {
  it('converts reviewed public fixtures into reviewed-export records and captures unlabeled candidates', async () => {
    const reviewedFixturePath = resolve('fixtures/public-data/pipeline-suite.json');
    const reviewedFixture = JSON.parse(await readFile(reviewedFixturePath, 'utf8'));
    const reviewedSubset = {
      pipelines: reviewedFixture.pipelines
        .slice(0, 1)
        .map((pipeline: typeof reviewedFixture.pipelines[number]) => ({
          ...pipeline,
          records: pipeline.records.slice(0, 1),
        })),
    };

    const unlabeledSuite = buildPublicScalePipelineSuite({
      taskmasterDialogs,
      abcdDataset,
      callLimit: 1,
      ticketLimit: 1,
      emailLimit: 1,
    });

    const dataset = buildReviewedBenchmarkDataset([
      {
        path: reviewedFixturePath,
        content: reviewedSubset,
      },
      {
        path: '/tmp/public-scale-pipeline-suite.json',
        content: unlabeledSuite,
      },
    ], {
      packVersion: 'public-benchmark-vtest',
      promptVersion: 'public-benchmark-prompt-vtest',
    });

    expect(dataset.summary.recordCount).toBe(1);
    expect(dataset.summary.annotationCandidateCount).toBe(3);
    expect(dataset.summary.byEngagementType.CALL).toBe(1);
    expect(dataset.annotationBatch.byEngagementType.CALL).toBe(1);
    expect(dataset.annotationBatch.byEngagementType.TICKET).toBe(1);
    expect(dataset.annotationBatch.byEngagementType.EMAIL).toBe(1);

    const scope = dataset.scopes[0];
    expect(scope?.tenantId).toBe('public_eval');
    expect(scope?.useCase).toBe('support');
    expect(scope?.records[0]?.review.analystSentiment?.score100).toBe(18);
    expect(scope?.records[0]?.packVersion).toBe('public-benchmark-vtest');
    expect(scope?.records[0]?.transcript).toBeTruthy();
  });

  it('writes a reviewed-export tree plus manifests and annotation batch', async () => {
    const reviewedFixturePath = resolve('fixtures/public-data/pipeline-suite.json');
    const reviewedFixture = JSON.parse(await readFile(reviewedFixturePath, 'utf8'));
    const reviewedSubset = {
      pipelines: reviewedFixture.pipelines
        .slice(0, 1)
        .map((pipeline: typeof reviewedFixture.pipelines[number]) => ({
          ...pipeline,
          records: pipeline.records.slice(0, 2),
        })),
    };

    const dataset = buildReviewedBenchmarkDataset([
      {
        path: reviewedFixturePath,
        content: reviewedSubset,
      },
    ]);
    const outputDir = await mkdtemp(join(tmpdir(), 'conversation-intelligence-reviewed-benchmark-'));
    const artifacts = await writeReviewedBenchmarkDataset(outputDir, dataset);

    expect(artifacts.scopeArtifacts).toHaveLength(1);
    const manifest = JSON.parse(await readFile(artifacts.scopeArtifacts[0]!.manifestPath, 'utf8'));
    expect(manifest.exportedCount).toBe(2);
    expect(manifest.analystSentimentCount).toBe(2);

    const latestJsonl = await readFile(artifacts.scopeArtifacts[0]!.latestPath, 'utf8');
    expect(latestJsonl.trim().split(/\r?\n/)).toHaveLength(2);

    const annotationBatch = await readFile(artifacts.annotationBatchPath, 'utf8');
    expect(annotationBatch.trim()).toBe('');
  });
});
