import { describe, expect, it } from 'vitest';
import {
  analyzeConversation,
  StubCanonicalAnalysisEngine,
} from '../src';
import { canonicalExtractionSchema } from '../src/contracts/analysis';
import { TenantPackDraft, TranscriptInputDraft } from '../src/contracts';
import transcriptFixture from '../fixtures/transcript.support.basic.json';
import transcriptWithAdminNote from '../fixtures/transcript.support.admin-note.json';
import tenantPackFixture from '../fixtures/tenant-pack.support.acme.json';

describe('analyzeConversation', () => {
  it('maps canonical events to tenant labels and stays verified when evidence is eligible', async () => {
    const engine = new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
      overallEndUserSentiment: {
        polarity: 'NEGATIVE',
        intensity: 0.84,
        confidence: 0.92,
        rationale: 'The customer reports a broken commitment and sarcastic frustration.',
      },
      aspectSentiments: [
        {
          target: 'refund process',
          aspect: 'speed',
          literalSentiment: 'POSITIVE',
          intendedSentiment: 'NEGATIVE',
          sarcasm: true,
          confidence: 0.88,
          rationale: 'The customer uses sarcasm about the delay.',
          evidence: [
            {
              turnId: 't3',
              speakerRole: 'END_USER',
              quote: 'Amazing, another seven days.',
            },
          ],
        },
      ],
      canonicalEvents: [
        {
          type: 'POLICY_CONFLICT',
          actorRole: 'END_USER',
          confidence: 0.86,
          rationale: 'The customer claims the refund promise was not honored.',
          businessImpact: 'HIGH',
          evidence: [
            {
              turnId: 't1',
              speakerRole: 'END_USER',
              quote: 'I was told yesterday this refund was fixed.',
            },
          ],
        },
      ],
      canonicalKeyMoments: [
        {
          type: 'PROMISE_BROKEN',
          actorRole: 'END_USER',
          startTurnId: 't1',
          endTurnId: 't3',
          confidence: 0.83,
          rationale: 'The user contrasts a prior promise with a new delay.',
          businessImpact: 'HIGH',
          evidence: [
            {
              turnId: 't1',
              speakerRole: 'END_USER',
              quote: 'I was told yesterday this refund was fixed.',
            },
          ],
        },
      ],
      summary: 'Customer frustration is driven by a missed refund commitment.',
      review: {
        state: 'VERIFIED',
        reasons: [],
      },
    }));

    const result = await analyzeConversation(
      transcriptFixture as TranscriptInputDraft,
      tenantPackFixture as TenantPackDraft,
      {
        engine,
        jobId: 'job_test_verified',
        now: new Date('2026-03-28T00:00:00.000Z'),
      },
    );

    expect(result.review.state).toBe('VERIFIED');
    expect(result.tenantMappedEvents[0].tenantLabel).toBe('refund_policy_mismatch');
    expect(result.speakerAssignments[0].role).toBe('END_USER');
  });

  it('forces review when key-moment evidence comes from an ineligible role', async () => {
    const engine = new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
      overallEndUserSentiment: null,
      aspectSentiments: [],
      canonicalEvents: [],
      canonicalKeyMoments: [
        {
          type: 'ESCALATION_REQUEST',
          actorRole: 'AGENT',
          startTurnId: 't3',
          endTurnId: 't3',
          confidence: 0.72,
          rationale: 'The agent requests supervisor approval.',
          businessImpact: 'HIGH',
          evidence: [
            {
              turnId: 't3',
              speakerRole: 'AGENT',
              quote: 'I can request supervisor approval.',
            },
          ],
        },
      ],
      summary: 'Agent requested supervisor approval.',
      review: {
        state: 'VERIFIED',
        reasons: [],
      },
    }));

    const result = await analyzeConversation(
      transcriptWithAdminNote as TranscriptInputDraft,
      tenantPackFixture as TenantPackDraft,
      {
        engine,
        jobId: 'job_test_review',
        now: new Date('2026-03-28T00:00:00.000Z'),
      },
    );

    expect(result.review.state).toBe('NEEDS_REVIEW');
    expect(result.review.reasons.join(' ')).toContain('ineligible role AGENT');
  });
});
