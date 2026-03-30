import { CanonicalExtraction } from '../contracts/analysis';
import { TenantPackDraft, TranscriptInputDraft } from '../contracts';
import basicTranscript from '../../fixtures/transcript.support.basic.json';
import adminNoteTranscript from '../../fixtures/transcript.support.admin-note.json';
import promiseBrokenTranscript from '../../fixtures/transcript.support.promise-broken.json';
import sarcasmTranscript from '../../fixtures/transcript.support.sarcasm.json';
import tenantPack from '../../fixtures/tenant-pack.support.acme.json';

export interface SupportFixtureEvalCase {
  name: string;
  transcript: TranscriptInputDraft;
  tenantPack: TenantPackDraft;
  extraction: CanonicalExtraction;
  expected: {
    reviewState: 'VERIFIED' | 'UNCERTAIN' | 'NEEDS_REVIEW';
    tenantLabels?: string[];
    reviewReasonIncludes?: string[];
  };
}

export const supportFixtureEvalCases: SupportFixtureEvalCase[] = [
  {
    name: 'promise-broken-maps-to-tenant-labels',
    transcript: promiseBrokenTranscript as TranscriptInputDraft,
    tenantPack: tenantPack as TenantPackDraft,
    extraction: {
      overallEndUserSentiment: {
        polarity: 'NEGATIVE',
        intensity: 0.91,
        confidence: 0.95,
        rationale: 'The user reports a missed commitment and requests escalation.',
      },
      aspectSentiments: [
        {
          target: 'refund timeline',
          aspect: 'resolution',
          literalSentiment: 'NEGATIVE',
          intendedSentiment: 'NEGATIVE',
          sarcasm: false,
          confidence: 0.92,
          rationale: 'The user is directly negative about the missed refund promise.',
          evidence: [
            {
              turnId: 't1',
              speakerRole: 'END_USER',
              quote: 'You told me this would be resolved yesterday.',
            },
          ],
        },
      ],
      canonicalEvents: [
        {
          type: 'PROMISE_BROKEN',
          actorRole: 'END_USER',
          confidence: 0.93,
          rationale: 'The customer says the prior promise was not kept.',
          businessImpact: 'HIGH',
          evidence: [
            {
              turnId: 't1',
              speakerRole: 'END_USER',
              quote: 'resolved yesterday',
            },
          ],
        },
        {
          type: 'ESCALATION_REQUEST',
          actorRole: 'END_USER',
          confidence: 0.9,
          rationale: 'The customer asks for a supervisor.',
          businessImpact: 'HIGH',
          evidence: [
            {
              turnId: 't3',
              speakerRole: 'END_USER',
              quote: 'Please get me a supervisor.',
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
          confidence: 0.9,
          rationale: 'The user moves from complaint to escalation over a missed commitment.',
          businessImpact: 'HIGH',
          evidence: [
            {
              turnId: 't1',
              speakerRole: 'END_USER',
              quote: 'resolved yesterday',
            },
          ],
        },
      ],
      summary: 'The user is upset about a missed commitment and requests escalation.',
      review: {
        state: 'VERIFIED',
        reasons: [],
        comments: [],
        history: [],
      },
    },
    expected: {
      reviewState: 'VERIFIED',
      tenantLabels: ['broken_commitment', 'supervisor_request'],
    },
  },
  {
    name: 'admin-note-contamination-forces-review',
    transcript: adminNoteTranscript as TranscriptInputDraft,
    tenantPack: tenantPack as TenantPackDraft,
    extraction: {
      overallEndUserSentiment: {
        polarity: 'NEGATIVE',
        intensity: 0.78,
        confidence: 0.74,
        rationale: 'The transcript suggests frustration, but evidence is partly contaminated by an internal note.',
      },
      aspectSentiments: [
        {
          target: 'resolution process',
          aspect: 'trust',
          literalSentiment: 'NEGATIVE',
          intendedSentiment: 'NEGATIVE',
          sarcasm: false,
          confidence: 0.61,
          rationale: 'The internal note is incorrectly treated as customer evidence.',
          evidence: [
            {
              turnId: 't2',
              speakerRole: 'ADMIN',
              quote: 'Customer appears frustrated.',
            },
          ],
        },
      ],
      canonicalEvents: [],
      canonicalKeyMoments: [],
      summary: 'The extraction is contaminated by an admin note.',
      review: {
        state: 'VERIFIED',
        reasons: [],
        comments: [],
        history: [],
      },
    },
    expected: {
      reviewState: 'NEEDS_REVIEW',
      reviewReasonIncludes: ['not from an eligible sentiment role', 'below threshold'],
    },
  },
  {
    name: 'sarcasm-case-stays-verified-with-eligible-evidence',
    transcript: sarcasmTranscript as TranscriptInputDraft,
    tenantPack: tenantPack as TenantPackDraft,
    extraction: {
      overallEndUserSentiment: {
        polarity: 'NEGATIVE',
        intensity: 0.83,
        confidence: 0.9,
        rationale: 'The user uses sarcasm to express frustration at another delay.',
      },
      aspectSentiments: [
        {
          target: 'shipment update',
          aspect: 'speed',
          literalSentiment: 'POSITIVE',
          intendedSentiment: 'NEGATIVE',
          sarcasm: true,
          confidence: 0.89,
          rationale: 'The phrase "great, another delay" is sarcastic in context.',
          evidence: [
            {
              turnId: 't1',
              speakerRole: 'END_USER',
              quote: 'Great, another delay.',
            },
          ],
        },
      ],
      canonicalEvents: [
        {
          type: 'FRUSTRATION_ONSET',
          actorRole: 'END_USER',
          confidence: 0.86,
          rationale: 'The first customer turn marks a sarcastic frustration spike.',
          businessImpact: 'MEDIUM',
          evidence: [
            {
              turnId: 't1',
              speakerRole: 'END_USER',
              quote: 'Great, another delay.',
            },
          ],
        },
      ],
      canonicalKeyMoments: [
        {
          type: 'FRUSTRATION_ONSET',
          actorRole: 'END_USER',
          startTurnId: 't1',
          endTurnId: 't1',
          confidence: 0.86,
          rationale: 'Customer sarcasm marks the start of frustration.',
          businessImpact: 'MEDIUM',
          evidence: [
            {
              turnId: 't1',
              speakerRole: 'END_USER',
              quote: 'Great, another delay.',
            },
          ],
        },
      ],
      summary: 'Customer sarcasm indicates a negative sentiment shift.',
      review: {
        state: 'VERIFIED',
        reasons: [],
        comments: [],
        history: [],
      },
    },
    expected: {
      reviewState: 'VERIFIED',
      tenantLabels: ['FRUSTRATION_ONSET'],
    },
  },
  {
    name: 'basic-fixture-missed-confidence-forces-review',
    transcript: basicTranscript as TranscriptInputDraft,
    tenantPack: tenantPack as TenantPackDraft,
    extraction: {
      overallEndUserSentiment: {
        polarity: 'NEGATIVE',
        intensity: 0.8,
        confidence: 0.58,
        rationale: 'Likely negative, but confidence is too low for production.',
      },
      aspectSentiments: [],
      canonicalEvents: [],
      canonicalKeyMoments: [],
      summary: 'Low confidence requires analyst review.',
      review: {
        state: 'VERIFIED',
        reasons: [],
        comments: [],
        history: [],
      },
    },
    expected: {
      reviewState: 'NEEDS_REVIEW',
      reviewReasonIncludes: ['Overall end-user sentiment confidence is below threshold.'],
    },
  },
];
