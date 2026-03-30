import { describe, expect, it } from 'vitest';
import {
  reversibleMaskAnalysisRequest,
  decodeExtraction,
  decodeSpeakerAssignments,
} from '../src/pii/masking';
import type { CanonicalExtraction } from '../src/contracts/analysis';
import type { SpeakerAssignment } from '../src/contracts/analysis';

const BASE_REQUEST = {
  transcript: {
    tenantId: 'acme',
    useCase: 'support',
    participants: [
      { speakerId: 'c1', displayName: 'Adam Smith', rawRoleLabel: 'customer' },
      { speakerId: 'a1', displayName: 'Agent Lee', rawRoleLabel: 'agent' },
    ],
    turns: [
      { turnId: 't1', speakerId: 'c1', text: 'Hi, my email is adam@example.com and my phone is 555-867-5309.' },
      { turnId: 't2', speakerId: 'a1', text: "I'll look that up for you right away." },
    ],
  },
  tenantPack: {
    tenantId: 'acme',
    useCase: 'support',
    packVersion: 'v1',
    analysisPolicy: { sentimentRoles: ['END_USER' as const], keyMomentRoles: ['END_USER' as const] },
    supportedCanonicalEventTypes: ['FRUSTRATION_ONSET' as const],
    engagementTypeMapping: [],
    speakerRoleMapping: [],
    policyDigest: [],
    sentimentConfig: {},
  },
  piiConfig: { enabled: true, maskDisplayNames: true, reversible: true, customRegexRules: [] },
};

describe('reversibleMaskAnalysisRequest', () => {
  it('replaces PII with unique tokens', () => {
    const { request, tokenMap } = reversibleMaskAnalysisRequest(BASE_REQUEST);
    const turn1 = request.transcript.turns[0].text;

    // Real values should be gone
    expect(turn1).not.toContain('adam@example.com');
    expect(turn1).not.toContain('555-867-5309');

    // Unique tokens should be present
    expect(turn1).toMatch(/__PII_\d+__/);
    expect(tokenMap.size).toBeGreaterThanOrEqual(2);
  });

  it('replaces display names with tokens when maskDisplayNames=true', () => {
    const { request, tokenMap } = reversibleMaskAnalysisRequest(BASE_REQUEST);

    const displayNames = request.transcript.participants.map((p) => p.displayName);
    expect(displayNames).not.toContain('Adam Smith');
    expect(displayNames).not.toContain('Agent Lee');

    // Token map should restore names
    for (const name of displayNames) {
      expect(tokenMap.has(name)).toBe(true);
    }
    expect(tokenMap.get(displayNames[0])).toBe('Adam Smith');
  });

  it('generates distinct tokens for each PII match', () => {
    const { tokenMap } = reversibleMaskAnalysisRequest(BASE_REQUEST);
    const tokens = Array.from(tokenMap.keys());
    const unique = new Set(tokens);
    expect(unique.size).toBe(tokens.length);
  });

  it('does not mask when piiConfig.enabled=false', () => {
    const req = { ...BASE_REQUEST, piiConfig: { enabled: false, maskDisplayNames: false, reversible: false, customRegexRules: [] } };
    const { request, tokenMap } = reversibleMaskAnalysisRequest(req);
    expect(request.transcript.turns[0].text).toContain('adam@example.com');
    expect(tokenMap.size).toBe(0);
  });
});

describe('decodeExtraction', () => {
  it('restores tokens in all string fields', () => {
    const { request, tokenMap } = reversibleMaskAnalysisRequest(BASE_REQUEST);

    // Simulate LLM returning masked content
    const maskedExtraction: CanonicalExtraction = {
      overallEndUserSentiment: {
        polarity: 'NEGATIVE',
        intensity: 0.7,
        confidence: 0.9,
        rationale: `User ${Array.from(tokenMap.keys())[0]} expressed frustration.`,
      },
      aspectSentiments: [],
      canonicalEvents: [{
        type: 'FRUSTRATION_ONSET',
        actorRole: 'END_USER',
        confidence: 0.8,
        rationale: 'Frustration detected.',
        businessImpact: 'HIGH',
        evidence: [{
          turnId: 't1',
          speakerRole: 'END_USER',
          // quote uses a masked email token
          quote: `Hi, my email is ${Array.from(tokenMap.keys()).find(k => tokenMap.get(k) === 'adam@example.com') ?? ''} and`,
        }],
      }],
      canonicalKeyMoments: [],
      summary: `Customer with email ${Array.from(tokenMap.keys()).find(k => tokenMap.get(k) === 'adam@example.com') ?? ''} is frustrated.`,
      review: { state: 'VERIFIED', reasons: [], comments: [], history: [] },
    };

    const decoded = decodeExtraction(maskedExtraction, tokenMap);

    expect(decoded.summary).toContain('adam@example.com');
    expect(decoded.overallEndUserSentiment?.rationale).toContain('Adam Smith');
    expect(decoded.canonicalEvents[0].evidence[0].quote).toContain('adam@example.com');
  });

  it('is a no-op when tokenMap is empty', () => {
    const extraction: CanonicalExtraction = {
      overallEndUserSentiment: null,
      aspectSentiments: [],
      canonicalEvents: [],
      canonicalKeyMoments: [],
      summary: 'No PII here.',
      review: { state: 'VERIFIED', reasons: [], comments: [], history: [] },
    };
    const decoded = decodeExtraction(extraction, new Map());
    expect(decoded).toBe(extraction); // same reference — no copy made
  });
});

describe('decodeSpeakerAssignments', () => {
  it('restores display names from token map', () => {
    const { tokenMap } = reversibleMaskAnalysisRequest(BASE_REQUEST);
    const nameToken = Array.from(tokenMap.keys()).find(k => tokenMap.get(k) === 'Adam Smith')!;

    const maskedAssignments: SpeakerAssignment[] = [{
      turnId: 't1',
      speakerId: 'c1',
      displayName: nameToken,
      role: 'END_USER',
      confidence: 0.9,
      provenance: ['role_label'],
      markers: [],
      eligibleForSentiment: true,
      eligibleForKeyMoments: true,
    }];

    const decoded = decodeSpeakerAssignments(maskedAssignments, tokenMap);
    expect(decoded[0].displayName).toBe('Adam Smith');
  });
});
