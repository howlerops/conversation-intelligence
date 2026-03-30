import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import publicPipelineSuiteFixture from '../fixtures/public-data/pipeline-suite.json';
import {
  buildPublicDataPipelineSuite,
  comparePublicAndShadowValidation,
  reviewedRunExportRecordSchema,
  writePublicDataPipelineArtifacts,
} from '../src';

describe('public vs shadow validation comparison', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(tempDirs.map(async (path) => rm(path, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('compares public offline slices against shadow reviewed-export data by engagement type', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-public-shadow-'));
    tempDirs.push(rootDir);

    const publicDir = join(rootDir, 'public');
    const shadowPath = join(rootDir, 'shadow', 'tenant_acme', 'support.jsonl');

    const suite = buildPublicDataPipelineSuite(publicPipelineSuiteFixture, () => new Date('2026-03-28T12:00:00.000Z'));
    await writePublicDataPipelineArtifacts(publicDir, suite);

    const shadowRecords = [
      reviewedRunExportRecordSchema.parse({
        runId: 'shadow-call-001',
        tenantId: 'tenant_acme',
        useCase: 'support',
        engagementType: 'CALL',
        createdAt: '2026-03-28T12:00:00.000Z',
        updatedAt: '2026-03-28T12:05:00.000Z',
        model: {
          polarity: 'NEGATIVE',
          intensity: 0.6,
          confidence: 0.9,
          rationale: 'Shadow call sample.',
          score: {
            method: 'derived_v1',
            score100: 20,
            score5: 1,
          },
        },
        review: {
          state: 'VERIFIED',
          decision: 'VERIFY',
          reviewedAt: '2026-03-28T12:05:00.000Z',
          reviewedById: 'analyst_1',
          reviewedByType: 'USER',
          analystSentiment: {
            score100: 24,
            score5: 2,
            correctionApplied: true,
            reviewedAt: '2026-03-28T12:05:00.000Z',
            reviewedById: 'analyst_1',
            reviewedByType: 'USER',
          },
          reasons: [],
        },
      }),
      reviewedRunExportRecordSchema.parse({
        runId: 'shadow-ticket-001',
        tenantId: 'tenant_acme',
        useCase: 'support',
        engagementType: 'TICKET',
        createdAt: '2026-03-28T12:10:00.000Z',
        updatedAt: '2026-03-28T12:15:00.000Z',
        model: {
          polarity: 'NEGATIVE',
          intensity: 0.55,
          confidence: 0.91,
          rationale: 'Shadow ticket sample.',
          score: {
            method: 'derived_v1',
            score100: 23,
            score5: 2,
          },
        },
        review: {
          state: 'VERIFIED',
          decision: 'VERIFY',
          reviewedAt: '2026-03-28T12:15:00.000Z',
          reviewedById: 'analyst_2',
          reviewedByType: 'USER',
          analystSentiment: {
            score100: 25,
            score5: 2,
            correctionApplied: false,
            reviewedAt: '2026-03-28T12:15:00.000Z',
            reviewedById: 'analyst_2',
            reviewedByType: 'USER',
          },
          reasons: [],
        },
      }),
    ];

    await mkdir(join(rootDir, 'shadow', 'tenant_acme'), { recursive: true });
    await writeFile(shadowPath, `${shadowRecords.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');

    const comparison = await comparePublicAndShadowValidation({
      publicPath: publicDir,
      shadowPath,
      clock: () => new Date('2026-03-28T13:00:00.000Z'),
    });

    expect(comparison.publicSummary.total).toBe(14);
    expect(comparison.shadowSummary.total).toBe(2);

    const callComparison = comparison.engagementComparisons.find((item) => item.engagementType === 'CALL');
    expect(callComparison?.public?.total).toBe(2);
    expect(callComparison?.shadow?.total).toBe(1);
    expect(callComparison?.deltas.averageDeltaScore100).toBeDefined();

    const ticketComparison = comparison.engagementComparisons.find((item) => item.engagementType === 'TICKET');
    expect(ticketComparison?.public?.total).toBe(4);
    expect(ticketComparison?.shadow?.total).toBe(1);

    const emailComparison = comparison.engagementComparisons.find((item) => item.engagementType === 'EMAIL');
    expect(emailComparison?.public?.total).toBe(8);

    const publicSummaryRaw = await readFile(join(publicDir, 'summary.json'), 'utf8');
    expect(publicSummaryRaw).toContain('"pipelineCount": 4');
  });
});
