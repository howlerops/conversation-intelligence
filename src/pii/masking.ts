import {
  AnalysisRequest,
  AnalysisRequestDraft,
  PiiConfig,
  PiiRedactionSummary,
  PiiRegexRule,
} from '../contracts';
import { analysisRequestSchema } from '../contracts/jobs';

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
