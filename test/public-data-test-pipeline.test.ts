import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import publicPipelineSuiteFixture from '../fixtures/public-data/pipeline-suite.json';
import doc2dialPipelineSuiteFixture from '../fixtures/public-data/pipeline-suite.support-doc2dial.json';
import callCenterEnPipelineSuiteFixture from '../fixtures/public-data/pipeline-suite.support-callcenteren.research.json';
import {
  buildPublicDataPipelineSuite,
  writePublicDataPipelineArtifacts,
} from '../src';

describe('public data test pipelines', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(tempDirs.map(async (path) => rm(path, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('builds normalized call, email, and ticket pipeline outputs from the spec-driven manifest', async () => {
    const suite = buildPublicDataPipelineSuite(publicPipelineSuiteFixture, () => new Date('2026-03-28T12:00:00.000Z'));

    expect(suite.summary.pipelineCount).toBe(4);
    expect(suite.summary.recordCount).toBe(14);
    expect(suite.summary.reviewedSentimentSampleCount).toBe(14);
    expect(suite.summary.byEngagementType).toEqual({
      CALL: 2,
      TICKET: 4,
      EMAIL: 8,
    });
    expect(suite.summary.byQueue.support_voice).toBe(2);
    expect(suite.summary.byQueue.support_async).toBe(4);
    expect(suite.summary.byQueue.support_email).toBe(5);
    expect(suite.summary.byQueue.collections_email).toBe(3);
    expect(suite.summary.byTranscriptLengthBucket.SHORT).toBeGreaterThan(0);
    expect(suite.summary.byTranscriptLengthBucket.MEDIUM).toBeGreaterThan(0);
    expect(suite.summary.byTranscriptLengthBucket.LONG).toBeGreaterThan(0);

    const callPipeline = suite.pipelines.find((pipeline) => pipeline.pipelineId === 'support-call-taskmaster');
    expect(callPipeline?.records[0]?.transcript.metadata.engagementType).toBe('CALL');
    expect(callPipeline?.records[0]?.reviewedSentimentSample?.sourceDataset).toBe('TASKMASTER');

    const ticketPipeline = suite.pipelines.find((pipeline) => pipeline.pipelineId === 'support-ticket-abcd');
    expect(ticketPipeline?.records[0]?.transcript.turns[1]?.text).toContain('[INTERNAL NOTE]');
    expect(ticketPipeline?.records[0]?.canonicalEventLabels).toEqual(['PROMISE_BROKEN', 'ESCALATION_REQUEST']);

    const emailPipeline = suite.pipelines.find((pipeline) => pipeline.pipelineId === 'collections-email-synthetic');
    expect(emailPipeline?.records[0]?.transcript.turns[0]?.text).toContain('Subject: Payment arrangement for account 3342');
    expect(emailPipeline?.records[0]?.reviewedSentimentSample?.engagementType).toBe('EMAIL');
    expect(emailPipeline?.records[0]?.reviewedSentimentSample?.datasetTrack).toBe('SYNTHETIC');

    const supportEmailPipeline = suite.pipelines.find((pipeline) => pipeline.pipelineId === 'support-email-synthetic');
    expect(supportEmailPipeline?.summary.byQueue.support_email).toBe(5);
    expect(supportEmailPipeline?.records[0]?.reviewedSentimentSample?.queue).toBe('support_email');
    expect(supportEmailPipeline?.summary.byTranscriptLengthBucket.MEDIUM).toBeGreaterThan(0);
    expect(supportEmailPipeline?.summary.byTranscriptLengthBucket.LONG).toBeGreaterThan(0);
  });

  it('writes suite artifacts for downstream eval tooling', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-public-pipeline-'));
    tempDirs.push(rootDir);

    const suite = buildPublicDataPipelineSuite(publicPipelineSuiteFixture, () => new Date('2026-03-28T12:00:00.000Z'));
    const artifacts = await writePublicDataPipelineArtifacts(rootDir, suite);

    expect(artifacts.pipelinePaths).toHaveLength(4);

    const summaryRaw = await readFile(artifacts.summaryPath, 'utf8');
    expect(summaryRaw).toContain('"pipelineCount": 4');
    expect(summaryRaw).toContain('"recordCount": 14');
    expect(summaryRaw).toContain('"support_email": 5');

    const callArtifacts = artifacts.pipelinePaths.find((pipeline) => pipeline.pipelineId === 'support-call-taskmaster');
    expect(callArtifacts?.reviewedSentimentPath).toBeDefined();

    const transcriptsRaw = await readFile(callArtifacts!.transcriptsPath, 'utf8');
    expect(transcriptsRaw).toContain('"engagementType":"CALL"');

    const reviewedRaw = await readFile(callArtifacts!.reviewedSentimentPath!, 'utf8');
    expect(reviewedRaw).toContain('"sourceDataset":"TASKMASTER"');
  });

  it('supports separate open-core and research-only manifests for additional source families', async () => {
    const doc2dialSuite = buildPublicDataPipelineSuite(doc2dialPipelineSuiteFixture, () => new Date('2026-03-28T12:00:00.000Z'));
    expect(doc2dialSuite.summary.pipelineCount).toBe(2);
    expect(doc2dialSuite.summary.byEngagementType.TICKET).toBe(2);
    expect(doc2dialSuite.pipelines.every((pipeline) => pipeline.datasetTrack === 'OPEN_CORE')).toBe(true);

    const callCenterEnSuite = buildPublicDataPipelineSuite(callCenterEnPipelineSuiteFixture, () => new Date('2026-03-28T12:00:00.000Z'));
    expect(callCenterEnSuite.summary.pipelineCount).toBe(1);
    expect(callCenterEnSuite.summary.byEngagementType.CALL).toBe(1);
    expect(callCenterEnSuite.pipelines[0]?.datasetTrack).toBe('RESEARCH_ONLY');
    expect(callCenterEnSuite.pipelines[0]?.records[0]?.reviewedSentimentSample?.sourceDataset).toBe('CALLCENTEREN');
  });
});
