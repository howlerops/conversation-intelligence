import { describe, expect, it } from 'vitest';
import {
  evaluateKeyMoments,
  summarizeKeyMomentEvals,
  ExpectedKeyMoment,
} from '../src/validation/key-moment-evaluation';
import { ConversationAnalysis } from '../src/contracts/analysis';

function makeAnalysis(keyMoments: ConversationAnalysis['canonicalKeyMoments']): ConversationAnalysis {
  return {
    jobId: 'test-job',
    tenantId: 'acme',
    useCase: 'support',
    analysisScope: { sentimentRoles: ['END_USER'], keyMomentRoles: ['END_USER'] },
    speakerSummary: { resolvedRoles: ['END_USER', 'AGENT'], confidence: 0.95 },
    overallEndUserSentiment: {
      polarity: 'NEGATIVE',
      intensity: 0.8,
      confidence: 0.9,
      rationale: 'Test',
    },
    aspectSentiments: [],
    canonicalEvents: [],
    canonicalKeyMoments: keyMoments,
    tenantMappedEvents: [],
    speakerAssignments: [],
    review: { state: 'VERIFIED', reasons: [], comments: [], history: [] },
    summary: 'Test analysis.',
    trace: {
      engine: 'rlm',
      packVersion: 'v1.0',
      promptVersion: 'v1.0',
      generatedAt: new Date().toISOString(),
    },
  } as unknown as ConversationAnalysis;
}

const transcript = {
  turns: [
    { turnId: 't1', text: 'I am really frustrated with this connector issue' },
    { turnId: 't2', text: 'I understand, let me help you resolve this' },
    { turnId: 't3', text: 'I want to speak to a supervisor right now' },
  ],
};

describe('key moment evaluation', () => {
  it('computes perfect precision and recall when all expected moments are detected', () => {
    const expected: ExpectedKeyMoment[] = [
      { type: 'FRUSTRATION_ONSET' },
      { type: 'ESCALATION_REQUEST' },
    ];

    const analysis = makeAnalysis([
      {
        type: 'FRUSTRATION_ONSET',
        actorRole: 'END_USER',
        startTurnId: 't1',
        endTurnId: 't1',
        confidence: 0.9,
        rationale: 'Frustration detected.',
        businessImpact: 'HIGH',
        evidence: [{ turnId: 't1', speakerRole: 'END_USER', quote: 'frustrated' }],
      },
      {
        type: 'ESCALATION_REQUEST',
        actorRole: 'END_USER',
        startTurnId: 't3',
        endTurnId: 't3',
        confidence: 0.85,
        rationale: 'Escalation requested.',
        businessImpact: 'CRITICAL',
        evidence: [{ turnId: 't3', speakerRole: 'END_USER', quote: 'supervisor' }],
      },
    ]);

    const result = evaluateKeyMoments('rec-1', analysis, expected, transcript);
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.f1).toBe(1);
    expect(result.truePositives).toBe(2);
    expect(result.falsePositives).toBe(0);
    expect(result.falseNegatives).toBe(0);
  });

  it('computes correct metrics when some moments are missed', () => {
    const expected: ExpectedKeyMoment[] = [
      { type: 'FRUSTRATION_ONSET' },
      { type: 'ESCALATION_REQUEST' },
    ];

    const analysis = makeAnalysis([
      {
        type: 'FRUSTRATION_ONSET',
        actorRole: 'END_USER',
        startTurnId: 't1',
        endTurnId: 't1',
        confidence: 0.9,
        rationale: 'Frustration detected.',
        businessImpact: 'HIGH',
        evidence: [{ turnId: 't1', speakerRole: 'END_USER', quote: 'frustrated' }],
      },
    ]);

    const result = evaluateKeyMoments('rec-2', analysis, expected, transcript);
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(0.5);
    expect(result.truePositives).toBe(1);
    expect(result.falseNegatives).toBe(1);
  });

  it('computes correct metrics for false positives', () => {
    const expected: ExpectedKeyMoment[] = [{ type: 'FRUSTRATION_ONSET' }];

    const analysis = makeAnalysis([
      {
        type: 'FRUSTRATION_ONSET',
        actorRole: 'END_USER',
        startTurnId: 't1',
        endTurnId: 't1',
        confidence: 0.9,
        rationale: 'Frustration.',
        businessImpact: 'HIGH',
        evidence: [{ turnId: 't1', speakerRole: 'END_USER', quote: 'frustrated' }],
      },
      {
        type: 'POLICY_CONFLICT',
        actorRole: 'END_USER',
        startTurnId: 't2',
        endTurnId: 't2',
        confidence: 0.6,
        rationale: 'Spurious detection.',
        businessImpact: 'LOW',
        evidence: [{ turnId: 't2', speakerRole: 'END_USER', quote: 'resolve' }],
      },
    ]);

    const result = evaluateKeyMoments('rec-3', analysis, expected, transcript);
    expect(result.precision).toBe(0.5);
    expect(result.recall).toBe(1);
    expect(result.falsePositives).toBe(1);
  });

  it('handles empty expected and detected moments', () => {
    const result = evaluateKeyMoments('rec-4', makeAnalysis([]), [], transcript);
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.f1).toBe(1);
  });

  it('validates evidence fidelity against transcript text', () => {
    const analysis = makeAnalysis([
      {
        type: 'FRUSTRATION_ONSET',
        actorRole: 'END_USER',
        startTurnId: 't1',
        endTurnId: 't1',
        confidence: 0.9,
        rationale: 'Frustration detected.',
        businessImpact: 'HIGH',
        evidence: [
          { turnId: 't1', speakerRole: 'END_USER', quote: 'frustrated' },
          { turnId: 't1', speakerRole: 'END_USER', quote: 'nonexistent_phrase_xyz' },
        ],
      },
    ]);

    const result = evaluateKeyMoments('rec-5', analysis, [{ type: 'FRUSTRATION_ONSET' }], transcript);
    expect(result.evidenceFidelityRate).toBe(0.5);
  });

  it('aggregates results into a summary with per-event-type metrics', () => {
    const results = [
      evaluateKeyMoments('r1', makeAnalysis([
        { type: 'FRUSTRATION_ONSET', actorRole: 'END_USER', startTurnId: 't1', endTurnId: 't1', confidence: 0.9, rationale: 'Test', businessImpact: 'HIGH', evidence: [{ turnId: 't1', speakerRole: 'END_USER', quote: 'frustrated' }] },
      ]), [{ type: 'FRUSTRATION_ONSET' }], transcript),
      evaluateKeyMoments('r2', makeAnalysis([]), [{ type: 'ESCALATION_REQUEST' }], transcript),
    ];

    const summary = summarizeKeyMomentEvals(results);
    expect(summary.totalRecords).toBe(2);
    expect(summary.totalExpected).toBe(2);
    expect(summary.totalTruePositives).toBe(1);
    expect(summary.totalFalseNegatives).toBe(1);
    expect(summary.byEventType['FRUSTRATION_ONSET']).toBeDefined();
    expect(summary.byEventType['FRUSTRATION_ONSET'].recall).toBe(1);
    expect(summary.byEventType['ESCALATION_REQUEST']).toBeDefined();
    expect(summary.byEventType['ESCALATION_REQUEST'].recall).toBe(0);
  });
});
