// ---------------------------------------------------------------------------
// Semantic trigger types
// ---------------------------------------------------------------------------

export interface SemanticTrigger {
  eventType: string;
  confidence: number;
  matchedTurnIndex: number;
  matchedTurnText: string;
}

export const DEFAULT_SEMANTIC_THRESHOLD = 0.75;

// ---------------------------------------------------------------------------
// Example phrases per event type
// Designed to cover the full semantic range including surface-form variants
// that regex patterns would miss. Includes both customer and agent phrasings.
// ---------------------------------------------------------------------------

const EVENT_TYPE_EXAMPLES: Record<string, string[]> = {
  FRUSTRATION_ONSET: [
    'I am so frustrated with how this has been handled.',
    'This is absolutely ridiculous and unacceptable.',
    'I cannot believe this is still not resolved.',
    'This is insane, I keep running into the same problem.',
    'Your service is a complete disaster right now.',
    'I am beyond frustrated with every single interaction.',
    'This whole experience has been a nightmare.',
  ],
  POLICY_CONFLICT: [
    'Your return article says thirty days but your last agent told me I was already too late.',
    'The policy says one thing but the agent told me something different.',
    'Your website says I qualify but the system says I do not.',
    'There is a contradiction between what your documentation says and what I was told.',
    'The written policy contradicts what your representative said.',
    'Your terms say one thing but your team applied a different rule.',
    'I was denied based on a policy that disagrees with your published guidelines.',
  ],
  PROMISE_BROKEN: [
    'You told me this would be resolved yesterday and nothing has happened.',
    'Each promised update window has passed without a concrete root-cause note.',
    'Every update says the next maintenance window will fix it and I am still waiting.',
    'The second replacement is the same incorrect model as the first one.',
    'I was told the refund would post on Monday and it still has not happened.',
    'You promised a callback and I never heard from anyone.',
    'You confirmed the replacement shipped but I still have no tracking.',
    'The fix was supposed to go out last week and the issue persists.',
  ],
  REPEAT_CONTACT_SIGNAL: [
    'I have explained this three times and your team still has not fixed the account lock.',
    'This is the second time I have had to call about the same issue.',
    'I have already followed up multiple times without a resolution.',
    'I am still manually rebuilding the same report because this has not been fixed.',
    'I have replied three times and the problem is still not resolved.',
    'I called last week and the week before and nothing has changed.',
    'Every time I contact you I get a different answer and the issue persists.',
  ],
  RESOLUTION_COMMITMENT: [
    'I will escalate this and send you an update by end of day.',
    'I have resolved the issue and confirmed the new date.',
    'I committed to send the next update in two hours.',
    'I opened a follow-up and will reply once I confirm the outcome.',
    'I have closed the case and documented the corrected flow.',
    'I will send the confirmation email right away.',
    'I will personally follow up with you tomorrow morning.',
  ],
  RESOLUTION_REJECTION: [
    'That does not solve my problem at all.',
    'I am not satisfied with that answer.',
    'A store credit is not acceptable, I need a full refund.',
    'The proposed solution does not work for my situation.',
    'I reject the offer because it does not cover my actual loss.',
    'That workaround is not going to work for us.',
    'I do not accept that as a resolution.',
  ],
  ESCALATION_REQUEST: [
    'Please get me a supervisor right now.',
    'I want to speak to a manager immediately.',
    'I escalated this as a priority incident.',
    'I escalated this to incident command and set the next update.',
    'I created a supervisor review and blocked the warehouse from shipping again.',
    'Please transfer me to someone who can actually resolve this.',
    'I need someone with authority to handle this case.',
    'I am filing a formal complaint if this is not fixed today.',
  ],
  REFUND_DELAY: [
    'Where is my refund? It was supposed to post three days ago.',
    'The refund still has not appeared in my account.',
    'I was promised a credit but I do not see it anywhere.',
    'My return was received two weeks ago and there is still no refund.',
    'The system shows the return but the refund is not processing.',
    'I have been waiting over a week for the refund to post.',
    'You approved the refund but the amount has not hit my account.',
  ],
  DOCUMENT_BLOCKER: [
    'The setup article does not match the product and the screenshots show menus not on my account.',
    'I cannot access the portal and the document is not showing on my account.',
    'The return label was supposed to be attached but the message came without any file.',
    'The wrong document was linked and I cannot complete the process.',
    'My account does not show the form I need to submit the claim.',
    'The confirmation page is missing from the portal for my account tier.',
    'I need the signed form but it is not attached to the ticket.',
  ],
  HARDSHIP_SIGNAL: [
    'I lost work last month and cannot make the full payment right now.',
    'I am struggling financially and cannot afford the full amount.',
    'I am going through a difficult time and need some flexibility.',
    'I cannot keep paying extra charges every week on my current income.',
    'I have had a reduction in income and need a payment plan.',
    'I do not have the funds to pay the full balance at this time.',
    'I am dealing with a financial hardship and asking for consideration.',
  ],
  PROMISE_TO_PAY: [
    'I can send one hundred and fifty dollars on Friday.',
    'I will make the payment by the end of the week.',
    'I can make the revised payment on Tuesday.',
    'I promise to pay the full amount on the fifteenth.',
    'I will send the payment as soon as my next paycheck clears.',
    'I commit to paying fifty dollars a week until the balance is cleared.',
    'You can count on me to pay the remaining balance on Thursday.',
  ],
};

// ---------------------------------------------------------------------------
// Module-level cache: example embeddings keyed by event type string
// Populated lazily on first call, reused thereafter.
// ---------------------------------------------------------------------------

const exampleEmbeddingCache = new Map<string, number[][]>();

export function clearSemanticTriggerCache(): void {
  exampleEmbeddingCache.clear();
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Embedding API
// ---------------------------------------------------------------------------

function buildEmbeddingsEndpoint(apiBase: string): string {
  const base = apiBase.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  return `${base}/v1/embeddings`;
}

async function fetchEmbedding(
  text: string,
  endpoint: string,
  signal?: AbortSignal,
): Promise<number[]> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', input: text }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Embedding API returned ${response.status}`);
  }
  const data = await response.json() as unknown;
  // Handle both OpenAI-compat format { data: [{ embedding }] } and Ollama native { embedding }
  if (
    data !== null &&
    typeof data === 'object' &&
    'data' in data &&
    Array.isArray((data as { data: unknown }).data) &&
    (data as { data: Array<{ embedding: number[] }> }).data[0]?.embedding
  ) {
    return (data as { data: Array<{ embedding: number[] }> }).data[0].embedding;
  }
  if (
    data !== null &&
    typeof data === 'object' &&
    'embedding' in data &&
    Array.isArray((data as { embedding: number[] }).embedding)
  ) {
    return (data as { embedding: number[] }).embedding;
  }
  throw new Error('Unexpected embedding response format');
}

async function getExampleEmbeddings(
  eventType: string,
  phrases: string[],
  endpoint: string,
  signal?: AbortSignal,
): Promise<number[][]> {
  const cached = exampleEmbeddingCache.get(eventType);
  if (cached) return cached;

  const embeddings = await Promise.all(
    phrases.map((phrase) => fetchEmbedding(phrase, endpoint, signal)),
  );
  exampleEmbeddingCache.set(eventType, embeddings);
  return embeddings;
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

export interface ComputeSemanticTriggersOptions {
  threshold?: number;
  signal?: AbortSignal;
  /**
   * When provided, use these example phrases for semantic matching instead of
   * the built-in EVENT_TYPE_EXAMPLES. Keys are event type names (any string);
   * values are representative example phrases for that event type.
   * Event types not present here fall back to the built-in examples.
   */
  eventExamples?: Record<string, string[]>;
}

export async function computeSemanticTriggers(
  turnTexts: string[],
  embeddingApiBase: string,
  options: ComputeSemanticTriggersOptions = {},
): Promise<SemanticTrigger[]> {
  const threshold = options.threshold ?? DEFAULT_SEMANTIC_THRESHOLD;
  const endpoint = buildEmbeddingsEndpoint(embeddingApiBase);
  // When external examples are provided, use those event types; otherwise fall back to built-in.
  const eventTypes: string[] = options.eventExamples
    ? Object.keys(options.eventExamples)
    : (Object.keys(EVENT_TYPE_EXAMPLES) as string[]);

  // Compute turn embeddings — bail out gracefully on any failure
  let turnEmbeddings: number[][];
  try {
    turnEmbeddings = await Promise.all(
      turnTexts.map((t) => fetchEmbedding(t, endpoint, options.signal)),
    );
  } catch {
    return [];
  }

  // For each event type, find the best (turn, example) pair above threshold
  const triggers: SemanticTrigger[] = [];
  for (const eventType of eventTypes) {
    const phrases = options.eventExamples?.[eventType]
      ?? EVENT_TYPE_EXAMPLES[eventType as keyof typeof EVENT_TYPE_EXAMPLES]
      ?? [];
    if (phrases.length === 0) continue;

    let exampleEmbeddings: number[][];
    try {
      exampleEmbeddings = await getExampleEmbeddings(eventType, phrases, endpoint, options.signal);
    } catch {
      // If examples can't be fetched, skip this event type (don't clear what we've cached)
      continue;
    }

    let bestSim = 0;
    let bestTurnIndex = 0;
    for (let ti = 0; ti < turnEmbeddings.length; ti++) {
      for (const exEmb of exampleEmbeddings) {
        const sim = cosineSimilarity(turnEmbeddings[ti], exEmb);
        if (sim > bestSim) {
          bestSim = sim;
          bestTurnIndex = ti;
        }
      }
    }

    if (bestSim >= threshold) {
      triggers.push({
        eventType,
        confidence: Number(bestSim.toFixed(3)),
        matchedTurnIndex: bestTurnIndex,
        matchedTurnText: turnTexts[bestTurnIndex],
      });
    }
  }

  return triggers.sort((a, b) => b.confidence - a.confidence);
}

// ---------------------------------------------------------------------------
// Prompt formatting helper (used by engine.ts)
// ---------------------------------------------------------------------------

export function formatSemanticTriggerSection(triggers: SemanticTrigger[]): string {
  if (triggers.length === 0) {
    return [
      '=== SEMANTIC TRIGGERS ===',
      '→ No triggers fired above threshold. Emit events only from direct transcript evidence.',
    ].join('\n');
  }

  // Cap to top-5 strongest signals to avoid overloading the prompt
  const topTriggers = triggers.slice(0, 5);

  const lines = [
    `=== SEMANTIC TRIGGERS (embedding similarity ≥ ${DEFAULT_SEMANTIC_THRESHOLD}) ===`,
    'GUIDANCE: The events below have strong semantic similarity to known patterns in this conversation.',
    'Emit the corresponding canonicalEvent and canonicalKeyMoment ONLY if the transcript contains clear evidence.',
    'NOTE: These triggers guide event detection only — do NOT use them to adjust sentiment scores.',
    ...topTriggers.map(
      (t) => `  ${t.eventType} — turn index ${t.matchedTurnIndex} — confidence ${t.confidence}`,
    ),
  ];
  return lines.join('\n');
}
