import { describe, expect, it } from 'vitest';
import { normalizeTranscript } from '../src/pipeline/normalize-transcript';
import { resolveSpeakers } from '../src/pipeline/resolve-speakers';
import { tenantPackSchema } from '../src/contracts/tenant-pack';

describe('resolveSpeakers', () => {
  it('gates admin notes out of end-user scoring', () => {
    const transcript = normalizeTranscript({
      tenantId: 'tenant_test',
      useCase: 'support',
      participants: [
        {
          speakerId: 'cust_1',
          displayName: 'Customer',
          metadata: { kind: 'external' },
        },
        {
          speakerId: 'note_1',
          displayName: 'Internal Note',
          rawRoleLabel: 'internal note',
          metadata: { kind: 'internal' },
        },
      ],
      turns: [
        {
          turnId: 't1',
          speakerId: 'cust_1',
          text: 'I am upset about this refund.',
          metadata: {},
        },
        {
          turnId: 't2',
          speakerId: 'note_1',
          text: '[ADMIN] escalate if needed',
          metadata: {},
        },
      ],
      metadata: {},
    });

    const pack = tenantPackSchema.parse({
      tenantId: 'tenant_test',
      packVersion: '1',
      analysisPolicy: {
        sentimentRoles: ['END_USER'],
        keyMomentRoles: ['END_USER'],
        contextRoles: ['END_USER', 'ADMIN'],
        speakerConfidenceReviewThreshold: 0.8,
      },
    });

    const assignments = resolveSpeakers(transcript, pack);

    expect(assignments[0].role).toBe('END_USER');
    expect(assignments[0].eligibleForSentiment).toBe(true);
    expect(assignments[1].role).toBe('ADMIN');
    expect(assignments[1].eligibleForSentiment).toBe(false);
  });
});
