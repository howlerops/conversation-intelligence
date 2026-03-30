import { z } from 'zod';

// Minimal local types for the recursive-llm-ts RLM interface.
// The actual class is loaded lazily via require() at runtime — only when structured mode is used.
// This avoids a compile-time dependency on the unbuilt dist/ in the git-installed package.
type RLMEventType = string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RLMEventMap = Record<RLMEventType, any>;

interface RlmInstance {
  structuredCompletion(
    query: string,
    context: string,
    schema: unknown,
    options: { maxRetries: number; parallelExecution: boolean; signal?: AbortSignal },
  ): Promise<{ result: z.infer<typeof llmExtractionSchema> }>;
  on(event: string, listener: (data: unknown) => void): void;
  off(event: string, listener: (data: unknown) => void): void;
}
import {
  aspectSentimentSchema,
  CanonicalExtraction,
  canonicalEventSchema,
  canonicalExtractionSchema,
  OverallSentiment,
  canonicalKeyMomentSchema,
  overallSentimentSchema,
} from '../contracts/analysis';
import { canonicalRoleSchema, impactLevelSchema } from '../contracts/roles';
import {
  CanonicalEventDefinition,
  supportCanonicalEventTypeSchema,
  SupportCanonicalEventType,
} from '../contracts/tenant-pack';
import { deriveScore5FromScore100, deriveSentimentScore } from '../sentiment/scoring';
import {
  computeSemanticTriggers,
  formatSemanticTriggerSection,
  type SemanticTrigger,
} from './semantic-triggers';

export interface CanonicalAnalysisRequest {
  query: string;
  context: string;
  signal?: AbortSignal;
  /** Dynamic event type definitions from the tenant pack. When present, the engine uses
   *  these to build the event type guidance section and semantic trigger examples. */
  eventTypeDefinitions?: Record<string, CanonicalEventDefinition>;
  /** Ordered list of supported event type names (used for post-parse filtering). */
  supportedEventTypes?: string[];
}

export interface CanonicalAnalysisEngineResult {
  extraction: CanonicalExtraction;
  engine: 'rlm' | 'rules' | 'test_stub';
  model?: string;
}

export interface CanonicalAnalysisEngine {
  analyze(input: CanonicalAnalysisRequest): Promise<CanonicalAnalysisEngineResult>;
}

export interface RlmConversationEngineConfig {
  model: string;
  apiKey?: string;
  apiBase?: string;
  mode?: 'structured' | 'ollama_json_compat';
  recursiveModel?: string;
  maxDepth?: number;
  maxIterations?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  requestTimeoutMs?: number;
  temperature?: number;
  structuredMaxRetries?: number;
  parallelExecution?: boolean;
  debug?: boolean;
  logOutput?: string;
  extraParams?: Record<string, unknown>;
  goBinaryPath?: string;
}

const llmReviewSchema = z.object({
  state: z.enum(['VERIFIED', 'NEEDS_REVIEW', 'UNCERTAIN']).default('VERIFIED'),
  reasons: z.array(z.string()).default([]),
});

const llmExtractionSchema = z.object({
  overallEndUserSentiment: overallSentimentSchema.nullable(),
  aspectSentiments: z.array(aspectSentimentSchema).default([]),
  canonicalEvents: z.array(canonicalEventSchema).default([]),
  canonicalKeyMoments: z.array(canonicalKeyMomentSchema).default([]),
  summary: z.string().min(1),
  review: llmReviewSchema.default({
    state: 'VERIFIED',
    reasons: [],
  }),
});

export class RlmCanonicalAnalysisEngine implements CanonicalAnalysisEngine {
  // Lazy — only created when structured mode is first used. This avoids requiring
  // the recursive-llm-ts dist/ at construction time (e.g., when using ollama_json_compat).
  private rlm: RlmInstance | undefined;
  private readonly rlmConfig: RlmConversationEngineConfig;
  private readonly model: string;
  private readonly apiBase?: string;
  private readonly apiKey?: string;
  private readonly mode: 'structured' | 'ollama_json_compat';
  private readonly maxTokens?: number;
  private readonly temperature: number;
  private readonly extraParams?: Record<string, unknown>;
  private readonly requestTimeoutMs?: number;
  private readonly structuredMaxRetries: number;
  private readonly parallelExecution: boolean;

  constructor(config: RlmConversationEngineConfig) {
    this.rlmConfig = config;
    this.model = config.model;
    this.apiBase = config.apiBase;
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.mode = config.mode ?? 'structured';
    this.maxTokens = config.maxTokens;
    this.temperature = config.temperature ?? 0;
    this.extraParams = config.extraParams;
    this.requestTimeoutMs = config.requestTimeoutMs;
    this.structuredMaxRetries = config.structuredMaxRetries ?? 3;
    this.parallelExecution = config.parallelExecution ?? true;
  }

  private getRlm(): RlmInstance {
    if (!this.rlm) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { RLM } = require('recursive-llm-ts') as { RLM: new (model: string, config: Record<string, unknown>) => RlmInstance };
      const config = this.rlmConfig;
      this.rlm = new RLM(config.model, {
        api_key: this.apiKey,
        api_base: config.apiBase,
        recursive_model: config.recursiveModel,
        max_depth: config.maxDepth ?? 2,
        max_iterations: config.maxIterations ?? 12,
        max_tokens: config.maxTokens,
        timeout: config.timeoutSeconds,
        temperature: config.temperature ?? 0,
        go_binary_path: config.goBinaryPath,
        debug: config.debug,
        observability: config.debug || config.logOutput
          ? {
            debug: true,
            log_output: config.logOutput ?? 'stderr',
          }
          : undefined,
        ...(config.extraParams ?? {}),
        context_overflow: {
          enabled: true,
          strategy: 'refine',
        },
      });
    }
    return this.rlm;
  }

  async analyze(input: CanonicalAnalysisRequest): Promise<CanonicalAnalysisEngineResult> {
    const { signal, cleanup, timedOut } = createOperationSignal(input.signal, this.requestTimeoutMs);

    try {
      if (this.mode === 'ollama_json_compat') {
        return {
          extraction: await this.analyzeWithOllamaJsonCompat(input, signal),
          engine: 'rlm',
          model: this.model,
        };
      }

      const result = await this.getRlm().structuredCompletion(
        input.query,
        input.context,
        llmExtractionSchema,
        {
          maxRetries: this.structuredMaxRetries,
          parallelExecution: this.parallelExecution,
          signal,
        },
      );

      return {
        extraction: normalizeLlmExtraction(result.result),
        engine: 'rlm',
        model: this.model,
      };
    } catch (error) {
      if (timedOut()) {
        throw new Error(`Canonical analysis timed out after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    } finally {
      cleanup();
    }
  }

  on<K extends RLMEventType>(event: K, listener: (eventData: RLMEventMap[K]) => void): this {
    this.getRlm().on(event, listener);
    return this;
  }

  off<K extends RLMEventType>(event: K, listener: (eventData: RLMEventMap[K]) => void): this {
    this.getRlm().off(event, listener);
    return this;
  }

  private async analyzeWithOllamaJsonCompat(
    input: CanonicalAnalysisRequest,
    signal: AbortSignal | undefined,
  ): Promise<CanonicalExtraction> {
    const endpoint = buildChatCompletionsEndpoint(this.apiBase);

    // Compute semantic triggers before the main LLM call.
    // Gracefully falls back to [] if the embedding API is unavailable.
    const compactContext = compactRepeatedTokenRuns(input.context);
    const turnTextMap = extractTurnTextsFromContext(compactContext);
    const turnTexts = Array.from(turnTextMap.values()).map((entry) => entry.text);
    const embeddingBase = this.apiBase ?? 'http://localhost:11434/v1';
    // Build per-event-type example phrase map from tenant pack definitions (if provided)
    const eventExamples: Record<string, string[]> | undefined = input.eventTypeDefinitions
      ? Object.fromEntries(
        Object.entries(input.eventTypeDefinitions)
          .filter(([, def]) => def.examplePhrases.length > 0)
          .map(([eventType, def]) => [eventType, def.examplePhrases]),
      )
      : undefined;
    const semanticTriggers = await computeSemanticTriggers(turnTexts, embeddingBase, {
      signal,
      ...(eventExamples && Object.keys(eventExamples).length > 0 ? { eventExamples } : {}),
    });

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are a conversation-intelligence extraction assistant. Return only valid JSON.',
          },
          {
            role: 'user',
            content: buildOllamaCompatPrompt(input, semanticTriggers),
          },
        ],
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        ...(this.extraParams ?? {}),
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama JSON compatibility request failed with ${response.status}: ${await response.text()}`);
    }

    const payload = ollamaChatResponseSchema.parse(await response.json());
    const content = payload.choices[0]?.message.content?.trim();
    if (!content) {
      throw new Error('Ollama JSON compatibility request returned empty content.');
    }

    let rawJson: string;
    try {
      rawJson = extractJsonObject(content);
    } catch {
      throw new Error(`Ollama response is not valid JSON: ${content.slice(0, 300)}`);
    }

    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(rawJson);
    } catch (err) {
      // Attempt to repair common JSON issues: trailing commas, unescaped newlines
      const repaired = rawJson
        .replace(/,\s*([}\]])/g, '$1')           // remove trailing commas
        .replace(/\n/g, '\\n')                    // escape literal newlines inside strings
        .replace(/\r/g, '\\r');
      try {
        parsedRaw = JSON.parse(repaired);
      } catch {
        throw new Error(`Ollama response could not be parsed as JSON: ${rawJson.slice(0, 300)}`);
      }
    }

    const parsed = ollamaCompatResponseSchema.parse(parsedRaw);
    const score100 = parsed.overallEndUserSentiment
      ? resolveOllamaCompatScore100(parsed.overallEndUserSentiment)
      : undefined;
    const overallEndUserSentiment = parsed.overallEndUserSentiment
      ? {
        polarity: parsed.overallEndUserSentiment.polarity,
        intensity: parsed.overallEndUserSentiment.intensity,
        confidence: parsed.overallEndUserSentiment.confidence,
        rationale: parsed.overallEndUserSentiment.rationale,
        score: typeof score100 === 'number'
          ? {
            method: 'model_v1' as const,
            score100,
            score5: deriveScore5FromScore100(score100),
          }
          : undefined,
      }
      : null;

    const validEventTypes = new Set(
      input.supportedEventTypes ?? supportCanonicalEventTypeSchema.options,
    );

    return canonicalExtractionSchema.parse({
      overallEndUserSentiment,
      aspectSentiments: [],
      canonicalEvents: parsed.canonicalEvents
        .filter((event) => validEventTypes.has(event.type as SupportCanonicalEventType))
        .map((event) => ({
          type: event.type,
          actorRole: event.actorRole,
          confidence: event.confidence,
          rationale: event.rationale,
          businessImpact: event.businessImpact,
          evidence: event.evidence.length > 0
            ? event.evidence
            : buildFallbackEvidence(event.actorRole, turnTextMap),
        })),
      canonicalKeyMoments: parsed.canonicalKeyMoments
        .filter((km) => validEventTypes.has(km.type as SupportCanonicalEventType))
        .map((km) => ({
          type: km.type,
          actorRole: km.actorRole,
          startTurnId: km.startTurnId,
          endTurnId: km.endTurnId,
          confidence: km.confidence,
          rationale: km.rationale,
          businessImpact: km.businessImpact,
          evidence: km.evidence.length > 0
            ? km.evidence
            : buildFallbackEvidence(km.actorRole, turnTextMap, km.startTurnId),
        })),
      summary: parsed.summary,
      review: {
        state: parsed.reviewState,
        reasons: parsed.reviewReasons,
        comments: [],
        history: [],
      },
    });
  }
}

function normalizeLlmExtraction(input: z.infer<typeof llmExtractionSchema>): CanonicalExtraction {
  return canonicalExtractionSchema.parse({
    ...input,
    review: {
      state: input.review.state,
      reasons: input.review.reasons,
      comments: [],
      history: [],
    },
  });
}

const ollamaCompatEvidenceSchema = z.object({
  turnId: z.string().min(1),
  speakerRole: canonicalRoleSchema.catch('END_USER'),
  quote: z.string().min(1),
});

const ollamaCompatEventSchema = z.object({
  type: z.string().min(1),  // validated against supportedCanonicalEventTypes after parsing
  actorRole: canonicalRoleSchema.catch('END_USER'),
  confidence: z.number().min(0).max(1).catch(0.7),
  rationale: z.string().min(1).catch('Detected from transcript.'),
  businessImpact: impactLevelSchema.catch('MEDIUM'),
  evidence: z.array(ollamaCompatEvidenceSchema).default([]),
});

const ollamaCompatKeyMomentSchema = z.object({
  type: z.string().min(1),  // validated against supportedCanonicalEventTypes after parsing
  actorRole: canonicalRoleSchema.catch('END_USER'),
  startTurnId: z.string().min(1),
  endTurnId: z.string().min(1),
  confidence: z.number().min(0).max(1).catch(0.7),
  rationale: z.string().min(1).catch('Key moment detected.'),
  businessImpact: impactLevelSchema.catch('MEDIUM'),
  evidence: z.array(ollamaCompatEvidenceSchema).default([]),
});

const ollamaCompatResponseSchema = z.object({
  summary: z.string().min(1),
  overallEndUserSentiment: z.object({
    polarity: overallSentimentSchema.shape.polarity,
    intensity: overallSentimentSchema.shape.intensity,
    confidence: overallSentimentSchema.shape.confidence,
    rationale: overallSentimentSchema.shape.rationale,
    score100: z.number().int().min(0).max(100).optional(),
  }).nullable(),
  canonicalEvents: z.array(ollamaCompatEventSchema).default([]),
  canonicalKeyMoments: z.array(ollamaCompatKeyMomentSchema).default([]),
  reviewState: z.enum(['VERIFIED', 'NEEDS_REVIEW', 'UNCERTAIN']).default('VERIFIED'),
  reviewReasons: z.array(z.string()).default([]),
});

const ollamaChatResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().optional(),
    }),
  })).min(1),
});

function buildEventTypeGuidanceLines(definitions: Record<string, CanonicalEventDefinition>): string[] {
  const lines: string[] = [
    '=== CANONICAL EVENT TYPES ===',
    'RULE: Every event you emit in canonicalEvents MUST also appear as an entry in canonicalKeyMoments with the same type. Both arrays must contain the same events.',
    'Emit canonicalEvents and matching canonicalKeyMoments for each of these patterns when present:',
  ];
  for (const [eventType, def] of Object.entries(definitions)) {
    const actorHint = def.actorRole ? ` actorRole=${def.actorRole}.` : '';
    lines.push(`- ${eventType}: ${def.description}${actorHint}`);
  }
  return lines;
}

const HARDCODED_EVENT_TYPE_LINES: string[] = [
  '=== CANONICAL EVENT TYPES ===',
  'RULE: Every event you emit in canonicalEvents MUST also appear as an entry in canonicalKeyMoments with the same type. Both arrays must contain the same events.',
  'Emit canonicalEvents and matching canonicalKeyMoments for each of these patterns when present:',
  '- FRUSTRATION_ONSET: END_USER explicitly expresses frustration, anger, or distress using negative emotional language (e.g. "frustrated", "ridiculous", "unacceptable", "this is insane"). Do NOT emit for factual issue reports without explicit negative emotion words. actorRole=END_USER.',
  '- PROMISE_BROKEN: A previous commitment was not kept (promised delivery, promised callback, promised refund not received). actorRole=AGENT or SYSTEM.',
  '- REPEAT_CONTACT_SIGNAL: END_USER mentions contacting multiple times, waited already, or is following up. actorRole=END_USER.',
  '- ESCALATION_REQUEST: An escalation occurred — either the END_USER explicitly asked for a supervisor/manager, or the AGENT escalated due to customer distress/urgency. actorRole=END_USER if customer requested; actorRole=AGENT if agent initiated the escalation.',
  '- REFUND_DELAY: END_USER asks about or is waiting for a refund/credit. actorRole=END_USER or SYSTEM.',
  '- POLICY_CONFLICT: A policy prevents or contradicts what the END_USER needs — includes: policy blocks request, agent contradicts written policy, conflicting information between agent and documentation. actorRole=AGENT or SYSTEM.',
  '- RESOLUTION_COMMITMENT: AGENT commits to a specific resolution, timeline, or follow-up. actorRole=AGENT.',
  '- RESOLUTION_REJECTION: END_USER rejects the proposed resolution. actorRole=END_USER.',
  '- DOCUMENT_BLOCKER: END_USER cannot proceed due to a missing, wrong, or inaccessible document, portal, or account setup issue. actorRole=END_USER or SYSTEM.',
  '- HARDSHIP_SIGNAL: END_USER discloses financial difficulty, inability to pay, or requests a payment plan. actorRole=END_USER.',
  '- PROMISE_TO_PAY: END_USER explicitly commits to making a payment on a specific date or amount. actorRole=END_USER.',
];

/** Exported for dataset export tooling — builds the user-turn prompt without semantic triggers. */
export function buildOllamaCompatPromptForExport(input: Pick<CanonicalAnalysisRequest, 'query' | 'context' | 'eventTypeDefinitions' | 'supportedEventTypes'>): string {
  return buildOllamaCompatPrompt(input as CanonicalAnalysisRequest, []);
}

function buildOllamaCompatPrompt(input: CanonicalAnalysisRequest, triggers: SemanticTrigger[]): string {
  const compactContext = compactRepeatedTokenRuns(input.context);
  const eventTypeLines = input.eventTypeDefinitions && Object.keys(input.eventTypeDefinitions).length > 0
    ? buildEventTypeGuidanceLines(input.eventTypeDefinitions)
    : HARDCODED_EVENT_TYPE_LINES;

  return [
    'Analyze the support conversation context and task below.',
    'Return ONLY valid JSON — no markdown, no code fences, no extra text before or after.',
    'Use exactly these keys:',
    '{',
    '  "summary": string,',
    '  "overallEndUserSentiment": {',
    '    "polarity": "VERY_NEGATIVE" | "NEGATIVE" | "NEUTRAL" | "POSITIVE" | "VERY_POSITIVE",',
    '    "intensity": number between 0 and 1,',
    '    "confidence": number between 0 and 1,',
    '    "rationale": string,',
    '    "score100": integer between 0 and 100',
    '  } | null,',
    '  "canonicalEvents": [{ "type": string, "actorRole": "END_USER"|"AGENT"|"SYSTEM", "confidence": number 0-1, "rationale": string, "businessImpact": "LOW"|"MEDIUM"|"HIGH"|"CRITICAL", "evidence": [{"turnId": string, "speakerRole": "END_USER"|"AGENT"|"SYSTEM", "quote": string (exact substring from that turn)}] }],',
    '  "canonicalKeyMoments": [{ "type": string, "actorRole": "END_USER"|"AGENT"|"SYSTEM", "startTurnId": string, "endTurnId": string, "confidence": number 0-1, "rationale": string, "businessImpact": "LOW"|"MEDIUM"|"HIGH"|"CRITICAL", "evidence": [{"turnId": string, "speakerRole": "END_USER"|"AGENT"|"SYSTEM", "quote": string (exact substring from that turn)}] }],',
    '  "reviewState": "VERIFIED" | "NEEDS_REVIEW" | "UNCERTAIN",',
    '  "reviewReasons": string[]',
    '}',
    '',
    ...eventTypeLines,
    '',
    formatSemanticTriggerSection(triggers),
    '',
    '=== EVIDENCE RULES ===',
    'Each event/moment requires at least one evidence entry:',
    '  - "turnId": must be an actual turn ID from the context (e.g., "t1", "t2", "turn-001")',
    '  - "quote": must be an exact verbatim substring from that turn\'s text (copy it, do not paraphrase)',
    '  - "speakerRole": must match the actual speaker of that turn',
    '',
    '=== SENTIMENT RULES ===',
    'Use null for overallEndUserSentiment only when no END_USER turns exist.',
    'Base sentiment ONLY on END_USER emotional language. Ignore agent/system turns for polarity.',
    'Keep score100 and polarity consistent:',
    '- VERY_NEGATIVE: 0-20 — explicit rage, severe trust breakdown, threats to cancel/escalate.',
    '- NEGATIVE: 10-40 — frustrated but cooperative, unresolved failures, hardship.',
    '- NEUTRAL: 45-55 — mixed or process-only conversations.',
    '- POSITIVE: 60-85 — resolved or appreciative conversations.',
    '- VERY_POSITIVE: 86-100 — exceptional delight.',
    'Routine thanks or cooperative payment plans: usually 60-80. Hardship/repeat follow-up: 25-40.',
    'Factual statements of unresolved commitments (missing tracking, refund unpaid, outage persisting despite promised fixes) score 20-30 even when calmly stated — the broken commitment is the signal, not the emotional tone.',
    'A concrete AGENT action (escalation confirmed, billing alerted, follow-up opened) raises the score 3-7 points above what the baseline complaint would warrant.',
    'Multi-day outages with daily business impact and repeated failed maintenance windows score 10-16 regardless of tone.',
    '',
    'If evidence is weak or contradictory, set reviewState to NEEDS_REVIEW.',
    '',
    `Task:\n${input.query}`,
    '',
    `Context:\n${compactContext}`,
  ].join('\n');
}


function compactRepeatedTokenRuns(text: string): string {
  return text.replace(/\b([A-Za-z0-9_-]{3,})\b(?:\s+\1\b){4,}/g, (match, token: string) => {
    const count = match.trim().split(/\s+/).length;
    return `${token} [repeated ${count}x]`;
  });
}


function resolveOllamaCompatScore100(
  sentiment: NonNullable<z.infer<typeof ollamaCompatResponseSchema>['overallEndUserSentiment']>,
): number {
  const derivedScore100 = deriveSentimentScore({
    polarity: sentiment.polarity,
    intensity: sentiment.intensity,
  }).score100;

  if (typeof sentiment.score100 !== 'number') {
    return derivedScore100;
  }

  if (!isScore100ConsistentWithPolarity(sentiment.score100, sentiment.polarity)) {
    return derivedScore100;
  }

  return Math.max(0, Math.min(100, Math.round(sentiment.score100)));
}

function isScore100ConsistentWithPolarity(
  score100: number,
  polarity: OverallSentiment['polarity'],
): boolean {
  const bounded = Math.max(0, Math.min(100, Math.round(score100)));

  switch (polarity) {
    case 'VERY_NEGATIVE':
      return bounded <= 20;
    case 'NEGATIVE':
      return bounded <= 40;
    case 'NEUTRAL':
      return bounded >= 45 && bounded <= 55;
    case 'POSITIVE':
      return bounded >= 60 && bounded <= 85;
    case 'VERY_POSITIVE':
      return bounded >= 86;
    default:
      return true;
  }
}

function buildChatCompletionsEndpoint(apiBase: string | undefined): string {
  const base = (apiBase ?? 'https://api.openai.com/v1').trim();
  if (base.includes('/chat/completions')) {
    return base;
  }
  return `${base.replace(/\/$/, '')}/chat/completions`;
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const fenceStripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  // Fast path: already clean JSON
  if (fenceStripped.startsWith('{') && fenceStripped.endsWith('}')) {
    return fenceStripped;
  }

  // Extract the outermost braces, handling nested objects
  const firstBrace = fenceStripped.indexOf('{');
  if (firstBrace < 0) {
    throw new Error(`Expected JSON object response, received: ${trimmed.slice(0, 200)}`);
  }

  // Walk from the first brace to find matching close brace
  let depth = 0;
  let lastClose = -1;
  let inString = false;
  let escape = false;

  for (let i = firstBrace; i < fenceStripped.length; i++) {
    const ch = fenceStripped[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        lastClose = i;
        break;
      }
    }
  }

  if (lastClose >= 0) {
    return fenceStripped.slice(firstBrace, lastClose + 1);
  }

  throw new Error(`Expected JSON object response, received: ${trimmed.slice(0, 200)}`);
}

/**
 * Extracts turn IDs and their text from the prompt context string.
 * Handles the format: [turnId] [speaker_id=...] [role=...] ... DisplayName: text
 */
function extractTurnTextsFromContext(context: string): Map<string, { role: string; text: string }> {
  const map = new Map<string, { role: string; text: string }>();
  // Match lines like: [t1] [speaker_id=x] [role=END_USER] ... Name: text
  const turnLineRe = /^\[([^\]]+)\]\s+(?:\[[^\]]*\]\s+)*\[role=([^\]]+)\][^\n]*?:\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = turnLineRe.exec(context)) !== null) {
    map.set(match[1], { role: match[2].trim(), text: match[3].trim() });
  }
  return map;
}

function extractLeadingSentences(text: string, maxSentences = 3): string {
  // Split on sentence-ending punctuation followed by whitespace or end-of-string
  const sentenceRe = /[^.!?]*[.!?]+(?:\s+|$)/g;
  const sentences: string[] = [];
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = sentenceRe.exec(text)) !== null) {
    sentences.push(match[0].trim());
    lastIndex = match.index + match[0].length;
    if (sentences.length >= maxSentences) break;
  }

  if (sentences.length > 0) {
    return sentences.join(' ').trim();
  }

  // No sentence boundaries found — text is one run-on fragment; return it as-is
  return text.trim();
}

function buildFallbackEvidence(
  actorRole: string,
  turnTextMap: Map<string, { role: string; text: string }>,
  preferredTurnId?: string,
): Array<{ turnId: string; speakerRole: string; quote: string }> {
  const quoteFrom = (turnId: string, text: string) => ({
    turnId,
    speakerRole: actorRole,
    quote: extractLeadingSentences(text, 3),
  });

  // Prefer the specified turn
  if (preferredTurnId && turnTextMap.has(preferredTurnId)) {
    const entry = turnTextMap.get(preferredTurnId)!;
    return [quoteFrom(preferredTurnId, entry.text)];
  }

  // Find the first turn matching the actor role
  for (const [turnId, entry] of turnTextMap) {
    if (entry.role === actorRole) {
      return [quoteFrom(turnId, entry.text)];
    }
  }

  // Last resort: use first available turn
  const firstEntry = turnTextMap.entries().next().value as [string, { role: string; text: string }] | undefined;
  if (firstEntry) {
    return [quoteFrom(firstEntry[0], firstEntry[1].text)];
  }

  return [{ turnId: 't1', speakerRole: actorRole, quote: 'unresolved' }];
}

export class StubCanonicalAnalysisEngine implements CanonicalAnalysisEngine {
  constructor(
    private readonly extraction:
      | CanonicalExtraction
      | ((input: CanonicalAnalysisRequest) => CanonicalExtraction),
  ) {}

  async analyze(input: CanonicalAnalysisRequest): Promise<CanonicalAnalysisEngineResult> {
    const extraction = typeof this.extraction === 'function'
      ? this.extraction(input)
      : this.extraction;

    return {
      extraction,
      engine: 'test_stub',
    };
  }
}

function createOperationSignal(
  upstreamSignal: AbortSignal | undefined,
  requestTimeoutMs: number | undefined,
): {
  signal: AbortSignal | undefined;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  if (typeof requestTimeoutMs !== 'number' || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    return {
      signal: upstreamSignal,
      cleanup: () => undefined,
      timedOut: () => false,
    };
  }

  const controller = new AbortController();
  let timeoutTriggered = false;
  const timeoutHandle = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort(new Error(`Timed out after ${requestTimeoutMs}ms`));
  }, requestTimeoutMs);

  const signal = upstreamSignal
    ? AbortSignal.any([upstreamSignal, controller.signal])
    : controller.signal;

  return {
    signal,
    cleanup: () => clearTimeout(timeoutHandle),
    timedOut: () => timeoutTriggered,
  };
}
