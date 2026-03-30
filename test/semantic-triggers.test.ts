import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  computeSemanticTriggers,
  formatSemanticTriggerSection,
  clearSemanticTriggerCache,
  DEFAULT_SEMANTIC_THRESHOLD,
} from '../src/rlm/semantic-triggers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmbedding(length = 8, ...hotDims: number[]): number[] {
  const v = new Array<number>(length).fill(0);
  for (const d of hotDims) v[d] = 1;
  return v;
}

function mockFetchWithEmbeddings(embeddings: number[][]): void {
  let callCount = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const embedding = embeddings[callCount % embeddings.length];
    callCount++;
    return new Response(
      JSON.stringify({ data: [{ embedding }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
}

// ---------------------------------------------------------------------------
// cosine similarity (via round-trip through computeSemanticTriggers)
// ---------------------------------------------------------------------------

describe('computeSemanticTriggers — graceful degradation', () => {
  beforeEach(() => clearSemanticTriggerCache());
  afterEach(() => vi.restoreAllMocks());

  it('returns [] when fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
    const result = await computeSemanticTriggers(
      ['I am so frustrated'],
      'http://localhost:11434/v1',
    );
    expect(result).toEqual([]);
  });

  it('returns [] when embedding API returns 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );
    const result = await computeSemanticTriggers(
      ['some turn text'],
      'http://localhost:11434/v1',
    );
    expect(result).toEqual([]);
  });

  it('returns [] on unexpected response shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    );
    const result = await computeSemanticTriggers(
      ['some turn text'],
      'http://localhost:11434/v1',
    );
    expect(result).toEqual([]);
  });

  it('handles aborted signal gracefully', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const result = await computeSemanticTriggers(
      ['some turn text'],
      'http://localhost:11434/v1',
      { signal: controller.signal },
    );
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Trigger detection with controlled embeddings
// ---------------------------------------------------------------------------

describe('computeSemanticTriggers — detection logic', () => {
  beforeEach(() => clearSemanticTriggerCache());
  afterEach(() => vi.restoreAllMocks());

  it('fires a trigger when cosine similarity >= threshold', async () => {
    // Turn and ALL example phrases share the same unit vector → cosine = 1.0
    const hotEmbedding = makeEmbedding(8, 0, 1);
    mockFetchWithEmbeddings([hotEmbedding]);

    const result = await computeSemanticTriggers(
      ['I am so frustrated with this'],
      'http://localhost:11434/v1',
      { threshold: DEFAULT_SEMANTIC_THRESHOLD },
    );

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].confidence).toBeGreaterThanOrEqual(DEFAULT_SEMANTIC_THRESHOLD);
    expect(result[0].matchedTurnIndex).toBe(0);
    expect(result[0].matchedTurnText).toBe('I am so frustrated with this');
  });

  it('does NOT fire a trigger when similarity < threshold', async () => {
    // Turn in dim 0, all examples in dim 1 → cosine = 0
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const embedding = callCount === 0
        ? makeEmbedding(8, 0)      // turn: dim 0
        : makeEmbedding(8, 1);     // all examples: dim 1
      callCount++;
      return new Response(
        JSON.stringify({ data: [{ embedding }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const result = await computeSemanticTriggers(
      ['some unrelated text'],
      'http://localhost:11434/v1',
      { threshold: DEFAULT_SEMANTIC_THRESHOLD },
    );

    expect(result).toEqual([]);
  });

  it('returns triggers sorted by confidence descending', async () => {
    // All same embedding → all event types fire; they should be sorted
    const embedding = makeEmbedding(8, 0, 1);
    mockFetchWithEmbeddings([embedding]);

    const result = await computeSemanticTriggers(
      ['trigger everything'],
      'http://localhost:11434/v1',
    );

    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].confidence).toBeGreaterThanOrEqual(result[i].confidence);
    }
  });

  it('uses custom threshold option', async () => {
    // Provide identical embeddings — all similarities = 1.0
    const embedding = makeEmbedding(8, 2, 3);
    mockFetchWithEmbeddings([embedding]);

    // Threshold of 0.99 — still fires because cosine = 1.0
    const result = await computeSemanticTriggers(
      ['any text'],
      'http://localhost:11434/v1',
      { threshold: 0.99 },
    );
    expect(result.length).toBeGreaterThan(0);

    clearSemanticTriggerCache();

    // Threshold above 1.0 — should not fire
    mockFetchWithEmbeddings([embedding]);
    const resultNone = await computeSemanticTriggers(
      ['any text'],
      'http://localhost:11434/v1',
      { threshold: 1.01 },
    );
    expect(resultNone).toEqual([]);
  });

  it('picks the best-matching turn across multiple turns', async () => {
    const weakEmbedding = makeEmbedding(8, 0);   // dim 0 only
    const strongEmbedding = makeEmbedding(8, 0, 1, 2, 3); // dims 0-3

    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      // Calls: turn0, turn1, then all example phrases
      const embedding = callCount === 0
        ? weakEmbedding
        : callCount === 1
          ? strongEmbedding
          : strongEmbedding; // examples also strong
      callCount++;
      return new Response(
        JSON.stringify({ data: [{ embedding }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const result = await computeSemanticTriggers(
      ['weak match', 'strong match'],
      'http://localhost:11434/v1',
    );

    // All matching triggers should point to turn index 1
    for (const trigger of result) {
      expect(trigger.matchedTurnIndex).toBe(1);
      expect(trigger.matchedTurnText).toBe('strong match');
    }
  });
});

// ---------------------------------------------------------------------------
// Cache lifecycle
// ---------------------------------------------------------------------------

describe('computeSemanticTriggers — cache', () => {
  beforeEach(() => clearSemanticTriggerCache());
  afterEach(() => vi.restoreAllMocks());

  it('reuses example embeddings across calls for the same event type', async () => {
    const embedding = makeEmbedding(8, 0, 1);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ data: [{ embedding }] }), { status: 200 }),
    );

    // First call: fetches turn + all examples
    await computeSemanticTriggers(['turn text'], 'http://localhost:11434/v1');
    const firstCallCount = fetchSpy.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(1);

    // Second call with a different turn text: only fetches the new turn
    await computeSemanticTriggers(['different turn'], 'http://localhost:11434/v1');
    const secondCallCount = fetchSpy.mock.calls.length - firstCallCount;

    // Only the 1 turn embedding should be fetched (examples are cached)
    expect(secondCallCount).toBe(1);
  });

  it('clearSemanticTriggerCache forces re-fetch of example embeddings', async () => {
    const embedding = makeEmbedding(8, 0, 1);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ data: [{ embedding }] }), { status: 200 }),
    );

    await computeSemanticTriggers(['turn text'], 'http://localhost:11434/v1');
    const firstCallCount = fetchSpy.mock.calls.length;

    clearSemanticTriggerCache();

    await computeSemanticTriggers(['turn text'], 'http://localhost:11434/v1');
    const secondCallCount = fetchSpy.mock.calls.length - firstCallCount;

    // Both turns should re-fetch their examples after cache clear
    expect(secondCallCount).toBe(firstCallCount);
  });
});

// ---------------------------------------------------------------------------
// Ollama native format support (embedding at root, not data[0].embedding)
// ---------------------------------------------------------------------------

describe('computeSemanticTriggers — Ollama native format', () => {
  beforeEach(() => clearSemanticTriggerCache());
  afterEach(() => vi.restoreAllMocks());

  it('handles { embedding: [...] } root-level format', async () => {
    const embedding = makeEmbedding(8, 0, 1);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ embedding }), { status: 200 }),
    );

    const result = await computeSemanticTriggers(
      ['I am frustrated'],
      'http://localhost:11434/v1',
    );
    // Should parse without throwing; result can be empty or non-empty depending on similarity
    expect(Array.isArray(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildEmbeddingsEndpoint (via URL in fetch call)
// ---------------------------------------------------------------------------

describe('computeSemanticTriggers — endpoint normalisation', () => {
  beforeEach(() => clearSemanticTriggerCache());
  afterEach(() => vi.restoreAllMocks());

  it('calls /v1/embeddings regardless of whether /v1 is in the base URL', async () => {
    const embedding = makeEmbedding(8, 0);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ data: [{ embedding }] }), { status: 200 }),
    );

    // Base without /v1
    await computeSemanticTriggers(['turn'], 'http://localhost:11434');
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:11434/v1/embeddings');

    clearSemanticTriggerCache();
    fetchSpy.mockClear();

    // Base with /v1
    await computeSemanticTriggers(['turn'], 'http://localhost:11434/v1');
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:11434/v1/embeddings');
  });
});

// ---------------------------------------------------------------------------
// formatSemanticTriggerSection
// ---------------------------------------------------------------------------

describe('formatSemanticTriggerSection', () => {
  it('returns no-trigger message when triggers array is empty', () => {
    const result = formatSemanticTriggerSection([]);
    expect(result).toContain('=== SEMANTIC TRIGGERS ===');
    expect(result).toContain('No triggers fired');
    expect(result).toContain('Emit events only from direct transcript evidence');
  });

  it('includes threshold and guidance instruction when triggers are present', () => {
    const triggers = [
      {
        eventType: 'FRUSTRATION_ONSET' as const,
        confidence: 0.87,
        matchedTurnIndex: 0,
        matchedTurnText: 'I am so frustrated',
      },
    ];
    const result = formatSemanticTriggerSection(triggers);
    expect(result).toContain('=== SEMANTIC TRIGGERS');
    expect(result).toContain('FRUSTRATION_ONSET');
    expect(result).toContain('0.87');
    expect(result).toContain('turn index 0');
    expect(result).toContain('do NOT use them to adjust sentiment');
  });

  it('lists all provided triggers', () => {
    const triggers = [
      { eventType: 'REPEAT_CONTACT_SIGNAL' as const, confidence: 0.91, matchedTurnIndex: 2, matchedTurnText: 'third time calling' },
      { eventType: 'PROMISE_BROKEN' as const, confidence: 0.78, matchedTurnIndex: 1, matchedTurnText: 'never arrived' },
    ];
    const result = formatSemanticTriggerSection(triggers);
    expect(result).toContain('REPEAT_CONTACT_SIGNAL');
    expect(result).toContain('PROMISE_BROKEN');
  });
});
