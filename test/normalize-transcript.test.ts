import { describe, expect, it } from 'vitest';
import { normalizeTranscript } from '../src/pipeline/normalize-transcript';

describe('normalizeTranscript', () => {
  it('collapses whitespace and preserves turn identifiers', () => {
    const normalized = normalizeTranscript({
      tenantId: 'tenant_test',
      useCase: 'support',
      participants: [
        {
          speakerId: 'cust_1',
          displayName: '  Customer  ',
          metadata: { kind: 'external' },
        },
      ],
      turns: [
        {
          turnId: 't1',
          speakerId: 'cust_1',
          text: '  This   is   frustrating.  ',
          metadata: {},
        },
      ],
      metadata: {},
    });

    expect(normalized.turns[0].turnId).toBe('t1');
    expect(normalized.turns[0].normalizedText).toBe('This is frustrating.');
    expect(normalized.turns[0].displayName).toBe('Customer');
  });
});
