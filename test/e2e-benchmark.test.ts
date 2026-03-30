import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalExtractionSchema,
  loadE2eBenchmarkSuiteFromPath,
  runE2eBenchmarkSuite,
  writeE2eBenchmarkArtifacts,
} from '../src';
import { CanonicalAnalysisEngine, StubCanonicalAnalysisEngine } from '../src/rlm/engine';
import tenantPackFixture from '../fixtures/tenant-pack.support.acme.json';

function buildEngine() {
  return new StubCanonicalAnalysisEngine((input) => {
    if (input.context.includes('SEVERE_DELAY')) {
      return canonicalExtractionSchema.parse({
        overallEndUserSentiment: {
          polarity: 'NEGATIVE',
          intensity: 0.5,
          confidence: 0.92,
          rationale: 'Call frustration is explicit.',
        },
        aspectSentiments: [],
        canonicalEvents: [],
        canonicalKeyMoments: [],
        summary: 'Severe delay call.',
        review: {
          state: 'VERIFIED',
          reasons: [],
          comments: [],
          history: [],
        },
      });
    }

    if (input.context.includes('HAPPY_RESOLUTION')) {
      return canonicalExtractionSchema.parse({
        overallEndUserSentiment: {
          polarity: 'POSITIVE',
          intensity: 0.4,
          confidence: 0.9,
          rationale: 'Email indicates a positive resolution.',
        },
        aspectSentiments: [],
        canonicalEvents: [],
        canonicalKeyMoments: [],
        summary: 'Happy resolution email.',
        review: {
          state: 'VERIFIED',
          reasons: [],
          comments: [],
          history: [],
        },
      });
    }

    if (input.context.includes('TICKET_FRICTION')) {
      return canonicalExtractionSchema.parse({
        overallEndUserSentiment: {
          polarity: 'NEGATIVE',
          intensity: 0.52,
          confidence: 0.83,
          rationale: 'Ticket shows unresolved friction.',
        },
        aspectSentiments: [],
        canonicalEvents: [],
        canonicalKeyMoments: [],
        summary: 'Ticket friction.',
        review: {
          state: 'NEEDS_REVIEW',
          reasons: ['Ticket needs manual validation.'],
          comments: [],
          history: [],
        },
      });
    }

    return canonicalExtractionSchema.parse({
      overallEndUserSentiment: {
        polarity: 'NEGATIVE',
        intensity: 0.4,
        confidence: 0.88,
        rationale: 'Export frustration.',
      },
      aspectSentiments: [],
      canonicalEvents: [],
      canonicalKeyMoments: [],
      summary: 'Reviewed export run.',
      review: {
        state: 'VERIFIED',
        reasons: [],
        comments: [],
        history: [],
      },
    });
  });
}

describe('e2e benchmark', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('runs end-to-end benchmarks across public suites and reviewed exports', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-e2e-benchmark-'));
    tempDirs.push(rootDir);

    const packPath = join(rootDir, 'tenant-pack.support.acme.json');
    await writeFile(packPath, JSON.stringify(tenantPackFixture, null, 2));

    const publicSuitePath = join(rootDir, 'public-suite.json');
    await writeFile(publicSuitePath, JSON.stringify({
      pipelines: [
        {
          pipelineId: 'call-suite',
          tenantId: 'tenant_acme',
          useCase: 'support',
          dataset: 'TASKMASTER',
          datasetTrack: 'OPEN_CORE',
          engagementType: 'CALL',
          description: 'Call benchmark.',
          records: [
            {
              recordId: 'call-001',
              participants: [
                { speakerId: 'customer', displayName: 'Customer', metadata: { kind: 'customer' } },
                { speakerId: 'agent', displayName: 'Agent', metadata: { kind: 'agent' } }
              ],
              turns: [
                { turnId: 't1', speakerId: 'customer', text: 'SEVERE_DELAY on my refund.', metadata: { queue: 'support_voice' } },
                { turnId: 't2', speakerId: 'agent', text: 'I can help.' }
              ],
              labels: {
                overallSentiment: {
                  polarity: 'NEGATIVE',
                  intensity: 0.5,
                  confidence: 1,
                  rationale: 'Reviewed call label.',
                  analystScore100: 25,
                  analystScore5: 2,
                  reviewState: 'VERIFIED'
                },
                canonicalEvents: [],
                tags: []
              },
              metadata: { engagementType: 'CALL', queue: 'support_voice' }
            }
          ]
        },
        {
          pipelineId: 'email-suite',
          tenantId: 'tenant_acme',
          useCase: 'support',
          dataset: 'SYNTHETIC_TEMPLATE',
          datasetTrack: 'SYNTHETIC',
          engagementType: 'EMAIL',
          description: 'Email benchmark.',
          records: [
            {
              recordId: 'email-001',
              participants: [
                { speakerId: 'customer', displayName: 'Customer', metadata: { kind: 'customer' } },
                { speakerId: 'agent', displayName: 'Agent', metadata: { kind: 'agent' } }
              ],
              messages: [
                { messageId: 'm1', senderId: 'customer', bodyText: 'HAPPY_RESOLUTION thanks for fixing this.', metadata: { queue: 'support_email' } },
                { messageId: 'm2', senderId: 'agent', bodyText: 'Glad to help.' }
              ],
              labels: {
                overallSentiment: {
                  polarity: 'POSITIVE',
                  intensity: 0.4,
                  confidence: 1,
                  rationale: 'Reviewed email label.',
                  analystScore100: 70,
                  analystScore5: 4,
                  reviewState: 'VERIFIED'
                },
                canonicalEvents: [],
                tags: []
              },
              metadata: { queue: 'support_email' }
            }
          ]
        },
        {
          pipelineId: 'ticket-suite',
          tenantId: 'tenant_acme',
          useCase: 'support',
          dataset: 'ABCD',
          datasetTrack: 'OPEN_CORE',
          engagementType: 'TICKET',
          description: 'Ticket benchmark.',
          records: [
            {
              recordId: 'ticket-001',
              participants: [
                { speakerId: 'customer', displayName: 'Customer', metadata: { kind: 'customer' } },
                { speakerId: 'agent', displayName: 'Agent', metadata: { kind: 'agent' } }
              ],
              comments: [
                { commentId: 'c1', authorId: 'customer', bodyText: 'TICKET_FRICTION and still blocked.', metadata: { queue: 'support_async' } },
                { commentId: 'c2', authorId: 'agent', bodyText: 'Investigating now.' }
              ],
              labels: {
                overallSentiment: {
                  polarity: 'NEGATIVE',
                  intensity: 0.52,
                  confidence: 1,
                  rationale: 'Reviewed ticket label.',
                  analystScore100: 24,
                  analystScore5: 2,
                  reviewState: 'NEEDS_REVIEW'
                },
                canonicalEvents: [],
                tags: []
              },
              metadata: { queue: 'support_async' }
            }
          ]
        }
      ]
    }, null, 2));

    const reviewedDir = join(rootDir, 'reviewed');
    await mkdir(reviewedDir, { recursive: true });
    const reviewedExportPath = join(reviewedDir, 'support.jsonl');
    await writeFile(reviewedExportPath, `${JSON.stringify({
      runId: 'reviewed-export-001',
      tenantId: 'tenant_acme',
      useCase: 'support',
      engagementType: 'CALL',
      queue: 'support_voice',
      transcriptTurnCount: 2,
      transcriptCharacterCount: 52,
      transcriptLengthBucket: 'SHORT',
      sourceDataset: 'tenant_shadow_support_fixture',
      datasetTrack: 'OPEN_CORE',
      conversationId: 'conv-reviewed-001',
      createdAt: '2026-03-28T00:00:00.000Z',
      updatedAt: '2026-03-28T00:01:00.000Z',
      packVersion: tenantPackFixture.packVersion,
      promptVersion: 'test-prompt',
      engine: 'rlm',
      transcript: {
        tenantId: 'tenant_acme',
        conversationId: 'conv-reviewed-001',
        useCase: 'support',
        participants: [
          { speakerId: 'customer', displayName: 'Customer', metadata: { kind: 'customer' } },
          { speakerId: 'agent', displayName: 'Agent', metadata: { kind: 'agent' } }
        ],
        turns: [
          { turnId: 'r1', speakerId: 'customer', text: 'EXPORT_FRUSTRATION and no response yet.', metadata: { engagementType: 'CALL', queue: 'support_voice' } },
          { turnId: 'r2', speakerId: 'agent', text: 'We are looking now.' }
        ],
        metadata: { engagementType: 'CALL', queue: 'support_voice' }
      },
      model: {
        polarity: 'NEGATIVE',
        intensity: 0.4,
        confidence: 0.9,
        rationale: 'Existing reviewed export model label.',
        score: {
          method: 'derived_v1',
          score100: 30,
          score5: 2
        }
      },
      review: {
        state: 'VERIFIED',
        analystSentiment: {
          score100: 30,
          score5: 2,
          correctionApplied: false,
          reviewedAt: '2026-03-28T00:01:00.000Z',
          reviewedById: 'analyst_1',
          reviewedByType: 'USER'
        },
        reasons: []
      }
    })}\n`);

    const suitePath = join(rootDir, 'benchmark-suite.json');
    await writeFile(suitePath, JSON.stringify({
      sources: [
        {
          sourceId: 'public-large',
          kind: 'public_pipeline_suite',
          path: './public-suite.json',
          tenantPackPath: './tenant-pack.support.acme.json',
          engagementTypes: ['CALL', 'EMAIL', 'TICKET']
        },
        {
          sourceId: 'reviewed-exports',
          kind: 'reviewed_run_exports',
          path: './reviewed',
          tenantPackPath: './tenant-pack.support.acme.json',
          requireAnalystSentiment: true
        }
      ]
    }, null, 2));

    const suite = await loadE2eBenchmarkSuiteFromPath(suitePath);
    const report = await runE2eBenchmarkSuite(suite, {
      engine: buildEngine(),
      concurrency: 2,
      now: () => new Date('2026-03-28T00:05:00.000Z'),
    });

    expect(report.summary.totalRecords).toBe(4);
    expect(report.summary.overall.failed).toBe(0);
    expect(report.summary.overall.compared).toBe(4);
    expect(report.summary.overall.reviewCount).toBe(1);
    expect(report.summary.bySource['public-large']?.total).toBe(3);
    expect(report.summary.bySource['reviewed-exports']?.total).toBe(1);
    expect(report.summary.byEngagementType.CALL?.total).toBe(2);
    expect(report.summary.byEngagementType.EMAIL?.total).toBe(1);
    expect(report.summary.byEngagementType.TICKET?.total).toBe(1);
    expect(report.summary.overall.averageDeltaScore100).toBe(0);
    expect(report.summary.overall.exactScore5MatchRate).toBe(1);
    expect(report.summary.overall.reviewStateMatchRate).toBe(1);

    const artifactsDir = join(rootDir, 'artifacts');
    const artifacts = await writeE2eBenchmarkArtifacts(artifactsDir, report);
    const summaryText = await readFile(artifacts.summaryPath, 'utf8');
    const recordsText = await readFile(artifacts.recordsPath, 'utf8');
    expect(summaryText).toContain('"totalRecords": 4');
    expect(recordsText.trim().split(/\r?\n/)).toHaveLength(4);
  });

  it('supports source filtering, progress callbacks, and per-record timeouts', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-e2e-timeout-'));
    tempDirs.push(rootDir);

    const packPath = join(rootDir, 'tenant-pack.support.acme.json');
    await writeFile(packPath, JSON.stringify(tenantPackFixture, null, 2));

    const publicSuitePath = join(rootDir, 'public-suite.json');
    await writeFile(publicSuitePath, JSON.stringify({
      pipelines: [
        {
          pipelineId: 'call-suite',
          tenantId: 'tenant_acme',
          useCase: 'support',
          dataset: 'TASKMASTER',
          datasetTrack: 'OPEN_CORE',
          engagementType: 'CALL',
          description: 'Call benchmark.',
          records: [
            {
              recordId: 'call-timeout',
              participants: [
                { speakerId: 'customer', displayName: 'Customer', metadata: { kind: 'customer' } },
                { speakerId: 'agent', displayName: 'Agent', metadata: { kind: 'agent' } }
              ],
              turns: [
                { turnId: 't1', speakerId: 'customer', text: 'TIMEOUT_CASE still waiting.' },
                { turnId: 't2', speakerId: 'agent', text: 'Acknowledged.' }
              ],
              labels: {
                overallSentiment: {
                  polarity: 'NEGATIVE',
                  intensity: 0.4,
                  confidence: 1,
                  rationale: 'Reviewed timeout label.',
                  analystScore100: 30,
                  analystScore5: 2,
                  reviewState: 'VERIFIED'
                },
                canonicalEvents: [],
                tags: []
              },
              metadata: { engagementType: 'CALL', queue: 'support_voice' }
            }
          ]
        },
        {
          pipelineId: 'email-suite',
          tenantId: 'tenant_acme',
          useCase: 'support',
          dataset: 'SYNTHETIC_TEMPLATE',
          datasetTrack: 'SYNTHETIC',
          engagementType: 'EMAIL',
          description: 'Email benchmark.',
          records: [
            {
              recordId: 'email-ok',
              participants: [
                { speakerId: 'customer', displayName: 'Customer', metadata: { kind: 'customer' } },
                { speakerId: 'agent', displayName: 'Agent', metadata: { kind: 'agent' } }
              ],
              messages: [
                { messageId: 'm1', senderId: 'customer', bodyText: 'HAPPY_RESOLUTION thanks.', metadata: { queue: 'support_email' } },
                { messageId: 'm2', senderId: 'agent', bodyText: 'Glad to help.' }
              ],
              labels: {
                overallSentiment: {
                  polarity: 'POSITIVE',
                  intensity: 0.4,
                  confidence: 1,
                  rationale: 'Reviewed email label.',
                  analystScore100: 70,
                  analystScore5: 4,
                  reviewState: 'VERIFIED'
                },
                canonicalEvents: [],
                tags: []
              },
              metadata: { engagementType: 'EMAIL', queue: 'support_email' }
            }
          ]
        }
      ]
    }, null, 2));

    const suitePath = join(rootDir, 'benchmark-suite.json');
    await writeFile(suitePath, JSON.stringify({
      sources: [
        {
          sourceId: 'public-filtered',
          kind: 'public_pipeline_suite',
          path: './public-suite.json',
          tenantPackPath: './tenant-pack.support.acme.json',
          recordIds: ['call-suite:call-timeout', 'email-suite:email-ok']
        }
      ]
    }, null, 2));

    const suite = await loadE2eBenchmarkSuiteFromPath(suitePath);
    const starts: string[] = [];
    const completes: Array<{ recordId: string; status: string }> = [];
    const timeoutAwareEngine: CanonicalAnalysisEngine = {
      async analyze(input) {
        if (input.context.includes('TIMEOUT_CASE')) {
          await new Promise<never>((_resolve, reject) => {
            input.signal?.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true });
          });
        }

        return {
          extraction: canonicalExtractionSchema.parse({
            overallEndUserSentiment: {
              polarity: 'POSITIVE',
              intensity: 0.4,
              confidence: 0.9,
              rationale: 'Recovered email.',
            },
            aspectSentiments: [],
            canonicalEvents: [],
            canonicalKeyMoments: [],
            summary: 'Email success.',
            review: {
              state: 'VERIFIED',
              reasons: [],
              comments: [],
              history: [],
            },
          }),
          engine: 'rules',
        };
      },
    };

    const report = await runE2eBenchmarkSuite(suite, {
      engine: timeoutAwareEngine,
      concurrency: 2,
      perRecordTimeoutMs: 25,
      onRecordStart: (update) => {
        starts.push(update.recordId);
      },
      onRecordComplete: (update) => {
        completes.push({ recordId: update.recordId, status: update.result.status });
      },
    });

    expect(starts).toEqual(['call-suite:call-timeout', 'email-suite:email-ok']);
    expect(completes).toEqual([
      { recordId: 'email-suite:email-ok', status: 'COMPLETED' },
      { recordId: 'call-suite:call-timeout', status: 'FAILED' },
    ]);
    expect(report.summary.totalRecords).toBe(2);
    expect(report.summary.overall.failed).toBe(1);
    expect(report.records.find((record) => record.recordId === 'call-suite:call-timeout')?.errorMessage).toContain('aborted by timeout');
  });
});
