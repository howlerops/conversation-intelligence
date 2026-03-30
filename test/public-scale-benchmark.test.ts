import { describe, expect, it } from 'vitest';
import {
  buildPublicScaleBenchmarkSuiteConfig,
  buildPublicScalePipelineSuite,
  buildPublicScalePipelineSuiteOutput,
} from '../src/validation/public-scale-benchmark';

const taskmasterSelf = [
  {
    conversation_id: 'self-001',
    instruction_id: 'support-like-self-1',
    utterances: [
      { speaker: 'USER', text: 'I still have not received the promised tracking update for the replacement device.' },
      { speaker: 'ASSISTANT', text: 'I am checking the shipment handoff now and will confirm what happened.' },
      { speaker: 'USER', text: 'This is the second time I have had to follow up and the rollout is blocked.' },
      { speaker: 'ASSISTANT', text: 'I understand. I am escalating the shipment issue and I will send the written update next.' },
    ],
  },
];

const taskmasterWoz = [
  {
    conversation_id: 'woz-001',
    instruction_id: 'support-like-woz-1',
    utterances: [
      { speaker: 'ASSISTANT', text: 'Thanks for calling support. What is going wrong today?' },
      { speaker: 'USER', text: 'The billing correction still has not appeared and finance is waiting on it.' },
      { speaker: 'ASSISTANT', text: 'I can see the adjustment is still pending review on the account.' },
      { speaker: 'USER', text: 'Please escalate it because we cannot close the month until it is fixed.' },
    ],
  },
];

const abcdDataset = {
  train: [
    {
      convo_id: 1,
      scenario: {
        flow: 'billing_issue',
        subflow: 'refund_delay',
      },
      original: [
        ['agent', 'Hi there, thanks for reaching out.'] as [string, string],
        ['customer', 'The refund was supposed to post on Monday and it still is not there.'] as [string, string],
        ['agent', 'I can see the refund is pending and I am escalating that now.'] as [string, string],
        ['customer', 'Please send me the written update when that happens because finance is asking for it.'] as [string, string],
      ],
    },
  ],
  dev: [],
  test: [],
};

describe('public scale benchmark builders', () => {
  it('builds a scale suite with deterministic counts and unlabeled scale records', () => {
    const suite = buildPublicScalePipelineSuite({
      taskmasterDialogs: {
        self: taskmasterSelf,
        woz: taskmasterWoz,
      },
      abcdDataset,
      callLimit: 2,
      ticketLimit: 1,
      emailLimit: 3,
    });

    expect(suite.pipelines).toHaveLength(3);
    expect(suite.pipelines[0]?.records).toHaveLength(2);
    expect(suite.pipelines[1]?.records).toHaveLength(1);
    expect(suite.pipelines[2]?.records).toHaveLength(3);

    const output = buildPublicScalePipelineSuiteOutput(suite, () => new Date('2026-03-29T00:00:00.000Z'));
    expect(output.summary.recordCount).toBe(6);
    expect(output.summary.reviewedSentimentSampleCount).toBe(0);
    expect(output.summary.byEngagementType.CALL).toBe(2);
    expect(output.summary.byEngagementType.TICKET).toBe(1);
    expect(output.summary.byEngagementType.EMAIL).toBe(3);
  });

  it('builds a benchmark suite config that combines scale ops and reviewed holdouts', () => {
    const benchmarkSuite = buildPublicScaleBenchmarkSuiteConfig({
      scaleManifestPath: '/tmp/public-scale-pipeline-suite.json',
      tenantPackPath: '/tmp/tenant-pack.support.acme.json',
      starterManifestPath: '/tmp/pipeline-suite.json',
      doc2dialManifestPath: '/tmp/pipeline-suite.support-doc2dial.json',
      callcenterenManifestPath: '/tmp/pipeline-suite.support-callcenteren.research.json',
    });

    expect(benchmarkSuite.sources).toHaveLength(4);
    expect(benchmarkSuite.sources[0]?.sourceId).toBe('public-scale-ops');
    expect(benchmarkSuite.sources[1]?.sourceId).toBe('public-reviewed-starter');
    expect(benchmarkSuite.sources[2]?.sourceId).toBe('public-reviewed-doc2dial');
    expect(benchmarkSuite.sources[3]?.sourceId).toBe('public-reviewed-callcenteren');
  });
});
