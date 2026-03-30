import { describe, expect, it } from 'vitest';
import { analyzeConversation } from '../src/pipeline/analyze-conversation';
import { StubCanonicalAnalysisEngine } from '../src/rlm/engine';
import { canonicalExtractionSchema } from '../src/contracts/analysis';
import { TenantPackDraft, TranscriptInputDraft } from '../src/contracts';
import transcriptFixture from '../fixtures/transcript.support.basic.json';
import tenantPackFixture from '../fixtures/tenant-pack.support.acme.json';

describe('evidence quality', () => {
  it('all evidence quotes reference valid turn IDs from the transcript', async () => {
    const transcript = transcriptFixture as TranscriptInputDraft;
    const turnIds = new Set(transcript.turns.map((t) => t.turnId));

    const result = await analyzeConversation(
      transcript,
      tenantPackFixture as TenantPackDraft,
      {
        engine: new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
          overallEndUserSentiment: {
            polarity: 'NEGATIVE',
            intensity: 0.8,
            confidence: 0.9,
            rationale: 'Customer expressed frustration.',
          },
          aspectSentiments: [{
            target: 'connector',
            aspect: 'reliability',
            literalSentiment: 'NEGATIVE',
            intendedSentiment: 'NEGATIVE',
            sarcasm: false,
            confidence: 0.85,
            rationale: 'Connector issues reported.',
            evidence: [{ turnId: transcript.turns[0].turnId, speakerRole: 'END_USER', quote: 'connector' }],
          }],
          canonicalEvents: [{
            type: 'FRUSTRATION_ONSET',
            actorRole: 'END_USER',
            confidence: 0.88,
            rationale: 'Customer is frustrated.',
            businessImpact: 'HIGH',
            evidence: [{ turnId: transcript.turns[0].turnId, speakerRole: 'END_USER', quote: 'frustrated' }],
          }],
          canonicalKeyMoments: [{
            type: 'FRUSTRATION_ONSET',
            actorRole: 'END_USER',
            startTurnId: transcript.turns[0].turnId,
            endTurnId: transcript.turns[0].turnId,
            confidence: 0.88,
            rationale: 'Frustration onset detected.',
            businessImpact: 'HIGH',
            evidence: [{ turnId: transcript.turns[0].turnId, speakerRole: 'END_USER', quote: 'frustrated' }],
          }],
          summary: 'Customer frustrated about connector issues.',
          review: { state: 'VERIFIED', reasons: [], comments: [], history: [] },
        })),
        jobId: 'evidence-test',
        now: new Date('2026-03-28T00:00:00.000Z'),
      },
    );

    for (const aspect of result.aspectSentiments) {
      for (const ref of aspect.evidence) {
        expect(turnIds.has(ref.turnId), `Aspect evidence turnId ${ref.turnId} not found in transcript`).toBe(true);
      }
    }

    for (const event of result.canonicalEvents) {
      for (const ref of event.evidence) {
        expect(turnIds.has(ref.turnId), `Event evidence turnId ${ref.turnId} not found in transcript`).toBe(true);
      }
    }

    for (const km of result.canonicalKeyMoments) {
      expect(turnIds.has(km.startTurnId), `Key moment startTurnId ${km.startTurnId} not found`).toBe(true);
      expect(turnIds.has(km.endTurnId), `Key moment endTurnId ${km.endTurnId} not found`).toBe(true);
      for (const ref of km.evidence) {
        expect(turnIds.has(ref.turnId), `Key moment evidence turnId ${ref.turnId} not found`).toBe(true);
      }
    }
  });

  it('speaker assignments cover all unique speakers in the transcript', async () => {
    const transcript = transcriptFixture as TranscriptInputDraft;
    const speakerIds = new Set(transcript.turns.map((t) => t.speakerId));

    const result = await analyzeConversation(
      transcript,
      tenantPackFixture as TenantPackDraft,
      {
        engine: new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
          overallEndUserSentiment: {
            polarity: 'NEUTRAL',
            intensity: 0.5,
            confidence: 0.8,
            rationale: 'Neutral conversation.',
          },
          aspectSentiments: [],
          canonicalEvents: [],
          canonicalKeyMoments: [],
          summary: 'Basic conversation.',
          review: { state: 'VERIFIED', reasons: [], comments: [], history: [] },
        })),
        jobId: 'speaker-coverage-test',
        now: new Date('2026-03-28T00:00:00.000Z'),
      },
    );

    const assignedSpeakers = new Set(result.speakerAssignments.map((a) => a.speakerId));
    for (const speakerId of speakerIds) {
      expect(assignedSpeakers.has(speakerId), `Speaker ${speakerId} has no assignment`).toBe(true);
    }
  });

  it('key moment turn ranges are ordered correctly', async () => {
    const transcript = transcriptFixture as TranscriptInputDraft;
    const turnOrder = transcript.turns.map((t) => t.turnId);

    const result = await analyzeConversation(
      transcript,
      tenantPackFixture as TenantPackDraft,
      {
        engine: new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
          overallEndUserSentiment: {
            polarity: 'NEGATIVE',
            intensity: 0.7,
            confidence: 0.85,
            rationale: 'Frustration.',
          },
          aspectSentiments: [],
          canonicalEvents: [],
          canonicalKeyMoments: [{
            type: 'FRUSTRATION_ONSET',
            actorRole: 'END_USER',
            startTurnId: turnOrder[0],
            endTurnId: turnOrder[Math.min(2, turnOrder.length - 1)],
            confidence: 0.85,
            rationale: 'Frustration spans first three turns.',
            businessImpact: 'HIGH',
            evidence: [{ turnId: turnOrder[0], speakerRole: 'END_USER', quote: 'issue' }],
          }],
          summary: 'Frustration detected.',
          review: { state: 'VERIFIED', reasons: [], comments: [], history: [] },
        })),
        jobId: 'turn-range-test',
        now: new Date('2026-03-28T00:00:00.000Z'),
      },
    );

    for (const km of result.canonicalKeyMoments) {
      const startIdx = turnOrder.indexOf(km.startTurnId);
      const endIdx = turnOrder.indexOf(km.endTurnId);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThanOrEqual(startIdx);
    }
  });
});
