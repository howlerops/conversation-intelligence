import {
  AnalysisRequest,
  AnalysisRequestDraft,
  PiiConfig,
  PiiRedactionSummary,
  PiiRegexRule,
} from '../contracts';
import { analysisRequestSchema } from '../contracts/jobs';
import type { CanonicalExtraction } from '../contracts/analysis';
import type { SpeakerAssignment } from '../contracts/analysis';

export interface PiiMaskInput {
  value: string;
  field: 'turnText' | 'displayName';
  speakerId?: string;
  turnId?: string;
}

export interface PiiTextMasker {
  name: string;
  mask(input: PiiMaskInput): { value: string; replacements: number };
}

export interface MaskAnalysisRequestOptions {
  customMaskers?: PiiTextMasker[];
}

const DEFAULT_REGEX_RULES: PiiRegexRule[] = [
  {
    name: 'EMAIL',
    pattern: '\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b',
    flags: 'gi',
  },
  {
    name: 'PHONE',
    pattern: '(?<!\\w)(?:\\+?1[-.\\s]?)?(?:\\(?\\d{3}\\)?[-.\\s]?\\d{3}[-.\\s]?\\d{4})(?!\\w)',
    flags: 'g',
  },
  {
    name: 'SSN',
    pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b',
    flags: 'g',
  },
  {
    name: 'CREDIT_CARD',
    pattern: '\\b(?:\\d[ -]*?){13,16}\\b',
    flags: 'g',
  },
];

function createRegexMasker(rule: PiiRegexRule): PiiTextMasker {
  return {
    name: rule.name,
    mask(input: PiiMaskInput) {
      const expression = new RegExp(rule.pattern, rule.flags);
      let replacements = 0;
      const replacement = rule.replacement ?? `[PII:${rule.name}]`;
      const value = input.value.replace(expression, () => {
        replacements += 1;
        return replacement;
      });

      return { value, replacements };
    },
  };
}

function buildMaskers(
  config: PiiConfig,
  options: MaskAnalysisRequestOptions,
): PiiTextMasker[] {
  const regexMaskers = [
    ...DEFAULT_REGEX_RULES,
    ...config.customRegexRules,
  ].map(createRegexMasker);

  return [...regexMaskers, ...(options.customMaskers ?? [])];
}

function applyMaskers(
  value: string,
  input: Omit<PiiMaskInput, 'value'>,
  maskers: PiiTextMasker[],
  ruleHits: Record<string, number>,
): { value: string; redactionCount: number } {
  let current = value;
  let redactionCount = 0;

  for (const masker of maskers) {
    const result = masker.mask({
      ...input,
      value: current,
    });

    current = result.value;
    redactionCount += result.replacements;

    if (result.replacements > 0) {
      ruleHits[masker.name] = (ruleHits[masker.name] ?? 0) + result.replacements;
    }
  }

  return { value: current, redactionCount };
}

// ---------------------------------------------------------------------------
// Reversible masking — generates unique per-request tokens and keeps a map
// so the original values can be restored in the analysis output.
// ---------------------------------------------------------------------------

/** Per-request token → original-value map.  Never persisted. */
export type PiiTokenMap = Map<string, string>;

/**
 * Like maskAnalysisRequest but generates unique tokens (e.g. `__PII_0__`)
 * instead of static labels so the masking is reversible.
 * Returns the masked request AND the token map needed to decode.
 */
export function reversibleMaskAnalysisRequest(
  request: AnalysisRequestDraft | AnalysisRequest,
  options: MaskAnalysisRequestOptions = {},
): { request: AnalysisRequest; summary: PiiRedactionSummary; tokenMap: PiiTokenMap } {
  const parsedRequest = analysisRequestSchema.parse(request);
  const piiConfig = parsedRequest.piiConfig;
  const tokenMap: PiiTokenMap = new Map();

  if (!piiConfig.enabled) {
    return {
      request: parsedRequest,
      summary: { applied: false, redactionCount: 0, ruleHits: {} },
      tokenMap,
    };
  }

  let tokenCounter = 0;
  const makeToken = () => `__PII_${tokenCounter++}__`;

  // Build regex rules (defaults + custom) for tokenized replacement
  const allRules: PiiRegexRule[] = [
    ...DEFAULT_REGEX_RULES,
    ...piiConfig.customRegexRules,
  ];

  // Custom maskers from options can't be reversed (they're opaque functions),
  // so fall back to standard replacement for those
  const customMaskers = options.customMaskers ?? [];

  const ruleHits: Record<string, number> = {};
  let totalRedactions = 0;

  function tokenizeText(value: string): string {
    let current = value;

    // Apply regex rules with unique tokens
    for (const rule of allRules) {
      const expression = new RegExp(rule.pattern, rule.flags);
      current = current.replace(expression, (match) => {
        const token = makeToken();
        tokenMap.set(token, match);
        ruleHits[rule.name] = (ruleHits[rule.name] ?? 0) + 1;
        totalRedactions++;
        return token;
      });
    }

    // Apply custom maskers with static labels (not reversible — opaque)
    for (const masker of customMaskers) {
      const result = masker.mask({ field: 'turnText', value: current });
      current = result.value;
      if (result.replacements > 0) {
        ruleHits[masker.name] = (ruleHits[masker.name] ?? 0) + result.replacements;
        totalRedactions += result.replacements;
      }
    }

    return current;
  }

  const participants = parsedRequest.transcript.participants.map((participant) => {
    if (!piiConfig.maskDisplayNames) return participant;
    const token = makeToken();
    tokenMap.set(token, participant.displayName);
    ruleHits['DISPLAY_NAME'] = (ruleHits['DISPLAY_NAME'] ?? 0) + 1;
    totalRedactions++;
    return { ...participant, displayName: token };
  });

  const turns = parsedRequest.transcript.turns.map((turn) => ({
    ...turn,
    text: tokenizeText(turn.text),
  }));

  return {
    request: {
      ...parsedRequest,
      transcript: { ...parsedRequest.transcript, participants, turns },
    },
    summary: { applied: true, redactionCount: totalRedactions, ruleHits },
    tokenMap,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces all `__PII_N__` tokens in every string field of a CanonicalExtraction
 * with their original values, restoring real names/emails/phones in quotes and rationales.
 */
export function decodeExtraction(
  extraction: CanonicalExtraction,
  tokenMap: PiiTokenMap,
): CanonicalExtraction {
  if (tokenMap.size === 0) return extraction;

  // Build a single-pass regex that matches any token
  const pattern = new RegExp(
    Array.from(tokenMap.keys()).map(escapeRegExp).join('|'),
    'g',
  );
  const decode = (s: string) => s.replace(pattern, (tok) => tokenMap.get(tok) ?? tok);

  return {
    ...extraction,
    summary: decode(extraction.summary),
    overallEndUserSentiment: extraction.overallEndUserSentiment
      ? {
        ...extraction.overallEndUserSentiment,
        rationale: decode(extraction.overallEndUserSentiment.rationale),
      }
      : null,
    aspectSentiments: extraction.aspectSentiments.map((a) => ({
      ...a,
      rationale: decode(a.rationale),
      evidence: a.evidence.map((e) => ({ ...e, quote: decode(e.quote) })),
    })),
    canonicalEvents: extraction.canonicalEvents.map((ev) => ({
      ...ev,
      rationale: decode(ev.rationale),
      evidence: ev.evidence.map((e) => ({ ...e, quote: decode(e.quote) })),
    })),
    canonicalKeyMoments: extraction.canonicalKeyMoments.map((km) => ({
      ...km,
      rationale: decode(km.rationale),
      evidence: km.evidence.map((e) => ({ ...e, quote: decode(e.quote) })),
    })),
    review: {
      ...extraction.review,
      reasons: extraction.review.reasons.map(decode),
      comments: extraction.review.comments.map((c) => ({ ...c, text: decode(c.text) })),
    },
  };
}

/**
 * Restores display names in speaker assignments using the token map.
 */
export function decodeSpeakerAssignments(
  assignments: SpeakerAssignment[],
  tokenMap: PiiTokenMap,
): SpeakerAssignment[] {
  if (tokenMap.size === 0) return assignments;
  const pattern = new RegExp(
    Array.from(tokenMap.keys()).map(escapeRegExp).join('|'),
    'g',
  );
  const decode = (s: string) => s.replace(pattern, (tok) => tokenMap.get(tok) ?? tok);
  return assignments.map((a) => ({ ...a, displayName: decode(a.displayName) }));
}

export function maskAnalysisRequest(
  request: AnalysisRequestDraft | AnalysisRequest,
  options: MaskAnalysisRequestOptions = {},
): { request: AnalysisRequest; summary: PiiRedactionSummary } {
  const parsedRequest = analysisRequestSchema.parse(request);
  const piiConfig = parsedRequest.piiConfig;

  if (!piiConfig.enabled) {
    return {
      request: parsedRequest,
      summary: {
        applied: false,
        redactionCount: 0,
        ruleHits: {},
      },
    };
  }

  const maskers = buildMaskers(piiConfig, options);
  const ruleHits: Record<string, number> = {};
  let totalRedactions = 0;

  const participants = parsedRequest.transcript.participants.map((participant) => {
    if (!piiConfig.maskDisplayNames) {
      return participant;
    }

    const masked = applyMaskers(
      participant.displayName,
      {
        field: 'displayName',
        speakerId: participant.speakerId,
      },
      maskers,
      ruleHits,
    );

    totalRedactions += masked.redactionCount;

    return {
      ...participant,
      displayName: masked.value,
    };
  });

  const turns = parsedRequest.transcript.turns.map((turn) => {
    const masked = applyMaskers(
      turn.text,
      {
        field: 'turnText',
        speakerId: turn.speakerId,
        turnId: turn.turnId,
      },
      maskers,
      ruleHits,
    );

    totalRedactions += masked.redactionCount;

    return {
      ...turn,
      text: masked.value,
    };
  });

  return {
    request: {
      ...parsedRequest,
      transcript: {
        ...parsedRequest.transcript,
        participants,
        turns,
      },
    },
    summary: {
      applied: true,
      redactionCount: totalRedactions,
      ruleHits,
    },
  };
}
