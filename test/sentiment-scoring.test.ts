import { describe, expect, it } from 'vitest';
import {
  TenantPackDraft,
  TranscriptInputDraft,
  analyzeConversation,
  calibrateExistingSentimentScore,
  canonicalExtractionSchema,
  deriveSentimentScore,
  recommendSentimentScoringConfig,
  runSentimentCalibration,
  summarizeSentimentCalibration,
} from '../src';
import reviewedSentimentOutcomesFixture from '../fixtures/sentiment-reviewed-outcomes.support.json';
import { StubCanonicalAnalysisEngine } from '../src/rlm/engine';
import transcriptFixture from '../fixtures/transcript.support.basic.json';
import tenantPackFixture from '../fixtures/tenant-pack.support.acme.json';

describe('sentiment scoring', () => {
  it('derives stable score100 and score5 values', () => {
    expect(deriveSentimentScore({
      polarity: 'NEGATIVE',
      intensity: 0.96,
    })).toEqual({
      method: 'derived_v1',
      score100: 2,
      score5: 1,
    });

    expect(deriveSentimentScore({
      polarity: 'NEUTRAL',
      intensity: 0,
    })).toEqual({
      method: 'derived_v1',
      score100: 50,
      score5: 3,
    });

    expect(deriveSentimentScore({
      polarity: 'POSITIVE',
      intensity: 0.9,
    })).toEqual({
      method: 'derived_v1',
      score100: 95,
      score5: 5,
    });

    expect(deriveSentimentScore({
      polarity: 'NEGATIVE',
      intensity: 0.52,
    }, {
      score100Offset: 3,
      context: {
        engagementType: 'TICKET',
      },
    })).toEqual({
      method: 'derived_v1_calibrated',
      score100: 27,
      score5: 2,
      calibration: {
        score100Offset: 3,
        engagementType: 'TICKET',
      },
    });

    expect(calibrateExistingSentimentScore({
      method: 'model_v1',
      score100: 73,
      score5: 4,
    }, {
      score100Offset: 3,
      context: {
        engagementType: 'EMAIL',
      },
    })).toEqual({
      method: 'model_v1_calibrated',
      score100: 76,
      score5: 4,
      calibration: {
        score100Offset: 3,
        engagementType: 'EMAIL',
      },
    });
  });

  it('adds derived sentiment scores to analyzed conversations and passes calibration fixtures', async () => {
    const engine = new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
      overallEndUserSentiment: {
        polarity: 'NEGATIVE',
        intensity: 0.52,
        confidence: 0.88,
        rationale: 'Customer frustration is clear but not maximal.',
      },
      aspectSentiments: [],
      canonicalEvents: [],
      canonicalKeyMoments: [],
      summary: 'Derived sentiment score test.',
      review: {
        state: 'VERIFIED',
        reasons: [],
        comments: [],
        history: [],
      },
    }));

    const analysis = await analyzeConversation(
      transcriptFixture as TranscriptInputDraft,
      tenantPackFixture as TenantPackDraft,
      {
        engine,
        jobId: 'job_sentiment_score',
        now: new Date('2026-03-28T00:00:00.000Z'),
      },
    );

    expect(analysis.overallEndUserSentiment?.score).toEqual({
      method: 'derived_v1',
      score100: 24,
      score5: 2,
    });

    const calibrationResults = runSentimentCalibration();
    expect(calibrationResults.every((result) => result.passed)).toBe(true);
    expect(calibrationResults.length).toBeGreaterThanOrEqual(18);
    expect(calibrationResults.some((result) => result.deltaScore100 > 0)).toBe(true);

    const summary = summarizeSentimentCalibration(calibrationResults);
    expect(summary.total).toBe(calibrationResults.length);
    expect(summary.passed).toBe(calibrationResults.length);
    expect(summary.maxDeltaScore100).toBeLessThanOrEqual(2);
    expect(summary.maxDeltaScore5).toBe(0);
    expect(summary.byScore5).toEqual({
      '1': 3,
      '2': 3,
      '3': 6,
      '4': 3,
      '5': 3,
    });
  });

  it('preserves model-provided sentiment scores and only applies configured calibration', async () => {
    const engine = new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
      overallEndUserSentiment: {
        polarity: 'POSITIVE',
        intensity: 0.52,
        confidence: 0.91,
        rationale: 'Customer appreciated the resolution.',
        score: {
          method: 'model_v1',
          score100: 73,
          score5: 4,
        },
      },
      aspectSentiments: [],
      canonicalEvents: [],
      canonicalKeyMoments: [],
      summary: 'Model score preservation test.',
      review: {
        state: 'VERIFIED',
        reasons: [],
        comments: [],
        history: [],
      },
    }));

    const analysis = await analyzeConversation(
      {
        ...(transcriptFixture as TranscriptInputDraft),
        metadata: {
          ...((transcriptFixture as TranscriptInputDraft).metadata ?? {}),
          engagementType: 'CALL',
        },
      },
      tenantPackFixture as TenantPackDraft,
      {
        engine,
        jobId: 'job_sentiment_model_score',
        now: new Date('2026-03-28T00:00:00.000Z'),
        sentimentScoringConfig: {
          enabled: true,
          defaultScore100Offset: 2,
          byEngagementType: {
            CALL: -1,
            EMAIL: 3,
            TICKET: undefined,
            CHAT: undefined,
          },
          byPolarity: {
            POSITIVE: 4,
          },
          byEngagementTypeAndPolarity: {
            CALL: {
              POSITIVE: 6,
            },
          },
        },
      },
    );

    expect(analysis.overallEndUserSentiment?.score).toEqual({
      method: 'model_v1_calibrated',
      score100: 79,
      score5: 4,
      calibration: {
        score100Offset: 6,
        engagementType: 'CALL',
      },
    });
  });

  it('recommends engagement-specific sentiment score offsets from reviewed samples', () => {
    const recommendation = recommendSentimentScoringConfig(reviewedSentimentOutcomesFixture, {
      minimumSampleSize: 10,
      minimumSampleSizePerEngagementType: 5,
    });

    expect(recommendation.recommendedConfig.enabled).toBe(true);
    expect(recommendation.recommendedConfig.defaultScore100Offset).toBe(2);
    expect(recommendation.recommendedConfig.byEngagementType).toEqual({
      CALL: 1,
      EMAIL: 1,
      TICKET: 3,
      CHAT: undefined,
    });
    expect(recommendation.byEngagementType.CALL?.sampleSize).toBe(7);
    expect(recommendation.byEngagementType.EMAIL?.sampleSize).toBe(6);
    expect(recommendation.byEngagementType.TICKET?.sampleSize).toBe(7);
  });

  it('applies support cue adjustments for negative broken-promise and positive resolved emails', async () => {
    const engine = new StubCanonicalAnalysisEngine((request) => {
      if (request.context.includes('replacement would be here yesterday')) {
        return canonicalExtractionSchema.parse({
          overallEndUserSentiment: {
            polarity: 'NEGATIVE',
            intensity: 0.3,
            confidence: 0.9,
            rationale: 'Missed replacement promise.',
            score: {
              method: 'model_v1',
              score100: 35,
              score5: 2,
            },
          },
          aspectSentiments: [],
          canonicalEvents: [],
          canonicalKeyMoments: [],
          summary: 'Negative call test.',
          review: {
            state: 'VERIFIED',
            reasons: [],
            comments: [],
            history: [],
          },
        });
      }

      return canonicalExtractionSchema.parse({
        overallEndUserSentiment: {
          polarity: 'POSITIVE',
          intensity: 0.64,
          confidence: 0.92,
          rationale: 'Resolved and appreciative.',
          score: {
            method: 'model_v1',
            score100: 82,
            score5: 5,
          },
        },
        aspectSentiments: [],
        canonicalEvents: [],
        canonicalKeyMoments: [],
        summary: 'Positive email test.',
        review: {
          state: 'VERIFIED',
          reasons: [],
          comments: [],
          history: [],
        },
      });
    });

    const negativeAnalysis = await analyzeConversation(
      {
        ...(transcriptFixture as TranscriptInputDraft),
        participants: [
          {
            speakerId: 'customer_1',
            displayName: 'Customer',
            rawRoleLabel: 'customer',
            metadata: { channel: 'phone' },
          },
          {
            speakerId: 'agent_1',
            displayName: 'Support Agent',
            rawRoleLabel: 'agent',
            metadata: { channel: 'phone' },
          },
        ],
        turns: [
          {
            turnId: 't1',
            speakerId: 'customer_1',
            text: 'You told me this replacement would be here yesterday and nothing has arrived.',
          },
          {
            turnId: 't2',
            speakerId: 'agent_1',
            text: 'I can escalate it now.',
          },
          {
            turnId: 't3',
            speakerId: 'customer_1',
            text: 'This is the second time I have had to call.',
          },
        ],
        metadata: {
          ...((transcriptFixture as TranscriptInputDraft).metadata ?? {}),
          engagementType: 'CALL',
        },
      },
      tenantPackFixture as TenantPackDraft,
      {
        engine,
        jobId: 'job_negative_cue_adjustment',
        now: new Date('2026-03-29T00:00:00.000Z'),
      },
    );

    expect(negativeAnalysis.overallEndUserSentiment?.score).toEqual({
      method: 'model_v1_calibrated',
      score100: 18,
      score5: 1,
      calibration: {
        score100Offset: -17,
        engagementType: 'CALL',
      },
    });

    const positiveAnalysis = await analyzeConversation(
      {
        ...(transcriptFixture as TranscriptInputDraft),
        participants: [
          {
            speakerId: 'customer_4',
            displayName: 'Customer',
            rawRoleLabel: 'customer',
            metadata: { channel: 'email' },
          },
          {
            speakerId: 'agent_4',
            displayName: 'Support Agent',
            rawRoleLabel: 'agent',
            metadata: { channel: 'email' },
          },
        ],
        turns: [
          {
            turnId: 'm1',
            speakerId: 'customer_4',
            text: 'The refund posted this morning. Thanks for staying on it and keeping me updated the last few days.',
          },
          {
            turnId: 'm2',
            speakerId: 'agent_4',
            text: 'Glad to hear it. I have closed the case, but reply if anything else looks off on the account.',
          },
        ],
        metadata: {
          ...((transcriptFixture as TranscriptInputDraft).metadata ?? {}),
          engagementType: 'EMAIL',
        },
      },
      tenantPackFixture as TenantPackDraft,
      {
        engine,
        jobId: 'job_positive_cue_adjustment',
        now: new Date('2026-03-29T00:00:00.000Z'),
      },
    );

    expect(positiveAnalysis.overallEndUserSentiment?.score).toEqual({
      method: 'model_v1_calibrated',
      score100: 78,
      score5: 4,
      calibration: {
        score100Offset: -4,
        engagementType: 'EMAIL',
      },
    });
  });

  it('applies stronger negative cue adjustments for repeated escalation calls and policy-conflict tickets', async () => {
    const engine = new StubCanonicalAnalysisEngine((request) => {
      if (request.context.includes('explained this three times')) {
        return canonicalExtractionSchema.parse({
          overallEndUserSentiment: {
            polarity: 'NEGATIVE',
            intensity: 0.52,
            confidence: 0.91,
            rationale: 'Repeated unresolved issue.',
            score: {
              method: 'model_v1',
              score100: 36,
              score5: 2,
            },
          },
          aspectSentiments: [],
          canonicalEvents: [],
          canonicalKeyMoments: [],
          summary: 'Repeated escalation call test.',
          review: {
            state: 'VERIFIED',
            reasons: [],
            comments: [],
            history: [],
          },
        });
      }

      return canonicalExtractionSchema.parse({
        overallEndUserSentiment: {
          polarity: 'NEGATIVE',
          intensity: 0.49,
          confidence: 0.9,
          rationale: 'Policy conflict and document blocker.',
          score: {
            method: 'model_v1',
            score100: 38,
            score5: 2,
          },
        },
        aspectSentiments: [],
        canonicalEvents: [],
        canonicalKeyMoments: [],
        summary: 'Policy conflict ticket test.',
        review: {
          state: 'VERIFIED',
          reasons: [],
          comments: [],
          history: [],
        },
      });
    });

    const repeatedCallAnalysis = await analyzeConversation(
      {
        ...(transcriptFixture as TranscriptInputDraft),
        participants: [
          {
            speakerId: 'customer_1',
            displayName: 'Customer',
            rawRoleLabel: 'customer',
            metadata: { channel: 'phone' },
          },
          {
            speakerId: 'agent_1',
            displayName: 'Agent',
            rawRoleLabel: 'agent',
            metadata: { channel: 'phone' },
          },
        ],
        turns: [
          {
            turnId: 't1',
            speakerId: 'customer_1',
            text: 'I have explained this three times and your team still has not fixed the account lock.',
          },
          {
            turnId: 't2',
            speakerId: 'agent_1',
            text: 'I understand, and I am escalating it to the supervisor desk now.',
          },
        ],
        metadata: {
          ...((transcriptFixture as TranscriptInputDraft).metadata ?? {}),
          engagementType: 'CALL',
        },
      },
      tenantPackFixture as TenantPackDraft,
      {
        engine,
        jobId: 'job_repeated_call_cue_adjustment',
        now: new Date('2026-03-29T00:00:00.000Z'),
      },
    );

    expect(repeatedCallAnalysis.overallEndUserSentiment?.score).toEqual({
      method: 'model_v1_calibrated',
      score100: 18,
      score5: 1,
      calibration: {
        score100Offset: -18,
        engagementType: 'CALL',
      },
    });

    const policyConflictAnalysis = await analyzeConversation(
      {
        ...(transcriptFixture as TranscriptInputDraft),
        participants: [
          {
            speakerId: 'customer_2',
            displayName: 'Customer',
            rawRoleLabel: 'customer',
            metadata: { channel: 'ticket' },
          },
          {
            speakerId: 'agent_2',
            displayName: 'Agent',
            rawRoleLabel: 'agent',
            metadata: { channel: 'ticket' },
          },
        ],
        turns: [
          {
            turnId: 'c1',
            speakerId: 'customer_2',
            text: 'The warranty page says a receipt or serial number is enough, but the claims form rejected me without both documents.',
          },
          {
            turnId: 'c2',
            speakerId: 'agent_2',
            text: 'I am escalating this because the form requirements do not match the published guidance.',
          },
        ],
        metadata: {
          ...((transcriptFixture as TranscriptInputDraft).metadata ?? {}),
          engagementType: 'TICKET',
        },
      },
      tenantPackFixture as TenantPackDraft,
      {
        engine,
        jobId: 'job_policy_conflict_ticket_adjustment',
        now: new Date('2026-03-29T00:00:00.000Z'),
      },
    );

    expect(policyConflictAnalysis.overallEndUserSentiment?.score).toEqual({
      method: 'model_v1_calibrated',
      score100: 28,
      score5: 2,
      calibration: {
        score100Offset: -10,
        engagementType: 'TICKET',
      },
    });
  });
});
