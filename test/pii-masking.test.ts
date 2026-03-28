import { describe, expect, it } from 'vitest';
import { maskAnalysisRequest, PiiMaskInput, PiiTextMasker } from '../src/pii/masking';
import { AnalysisRequestDraft } from '../src/contracts/jobs';
import { TenantPackDraft, TranscriptInputDraft } from '../src/contracts';
import transcriptFixture from '../fixtures/transcript.support.basic.json';
import tenantPackFixture from '../fixtures/tenant-pack.support.acme.json';

function createAccountMasker(): PiiTextMasker {
  return {
    name: 'ACCOUNT_TOKEN',
    mask(input: PiiMaskInput) {
      let replacements = 0;
      const value = input.value.replace(/\bACC-\d{4}\b/g, () => {
        replacements += 1;
        return '[PII:ACCOUNT]';
      });

      return { value, replacements };
    },
  };
}

describe('maskAnalysisRequest', () => {
  it('applies default regex masking and custom masking hooks', () => {
    const request: AnalysisRequestDraft = {
      transcript: {
        ...structuredClone(transcriptFixture) as TranscriptInputDraft,
        participants: [
          {
            speakerId: 'spk_end_user',
            displayName: 'Case ACC-4455',
          },
          ...(structuredClone(transcriptFixture.participants) as TranscriptInputDraft['participants']).slice(1),
        ],
        turns: [
          {
            ...(structuredClone(transcriptFixture.turns[0]) as TranscriptInputDraft['turns'][number]),
            text: 'Email sam@example.com or call 602-555-0100 about ACC-4455.',
          },
          ...(structuredClone(transcriptFixture.turns) as TranscriptInputDraft['turns']).slice(1),
        ],
      },
      tenantPack: structuredClone(tenantPackFixture) as TenantPackDraft,
      piiConfig: {
        enabled: true,
        maskDisplayNames: true,
        customRegexRules: [],
      },
    };

    const masked = maskAnalysisRequest(request, {
      customMaskers: [createAccountMasker()],
    });

    expect(masked.request.transcript.turns[0].text).toContain('[PII:EMAIL]');
    expect(masked.request.transcript.turns[0].text).toContain('[PII:PHONE]');
    expect(masked.request.transcript.turns[0].text).toContain('[PII:ACCOUNT]');
    expect(masked.request.transcript.participants[0].displayName).toContain('[PII:ACCOUNT]');
    expect(masked.summary.redactionCount).toBe(4);
    expect(masked.summary.ruleHits.EMAIL).toBe(1);
    expect(masked.summary.ruleHits.PHONE).toBe(1);
    expect(masked.summary.ruleHits.ACCOUNT_TOKEN).toBe(2);
  });
});
