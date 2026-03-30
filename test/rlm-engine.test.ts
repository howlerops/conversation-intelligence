import { afterEach, describe, expect, it, vi } from 'vitest';
import { RlmCanonicalAnalysisEngine } from '../src/rlm/engine';

describe('RlmCanonicalAnalysisEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a consistent Ollama-compatible score100 and compacts repeated tokens in the prompt', async () => {
    let requestBody = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: unknown, init?: RequestInit) => {
      requestBody = typeof init?.body === 'string' ? init.body : '';
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'Resolved support email.',
                overallEndUserSentiment: {
                  polarity: 'POSITIVE',
                  intensity: 0.78,
                  confidence: 0.91,
                  rationale: 'The customer confirmed resolution and thanked the team.',
                  score100: 82,
                },
                reviewState: 'VERIFIED',
                reviewReasons: [],
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    });

    const engine = new RlmCanonicalAnalysisEngine({
      model: 'qwen3.5',
      apiBase: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      mode: 'ollama_json_compat',
      maxTokens: 512,
      extraParams: {
        reasoning_effort: 'none',
      },
    });

    const result = await engine.analyze({
      query: 'Summarize the conversation.',
      context: 'resolved resolved resolved resolved resolved resolved resolved resolved resolved resolved',
    });

    expect(result.extraction.overallEndUserSentiment?.score).toEqual({
      method: 'model_v1',
      score100: 82,
      score5: 5,
    });
    expect(requestBody).toContain('[repeated 10x]');
  });

  it('falls back to derived scoring when Ollama-compatible score100 disagrees with polarity', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Delayed shipment call.',
              overallEndUserSentiment: {
                polarity: 'NEGATIVE',
                intensity: 0.7,
                confidence: 0.95,
                rationale: 'The customer is frustrated about the missed delivery.',
                score100: 75,
              },
              reviewState: 'VERIFIED',
              reviewReasons: [],
            }),
          },
        },
      ],
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    }));

    const engine = new RlmCanonicalAnalysisEngine({
      model: 'qwen3.5',
      apiBase: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      mode: 'ollama_json_compat',
      maxTokens: 512,
      extraParams: {
        reasoning_effort: 'none',
      },
    });

    const result = await engine.analyze({
      query: 'Summarize the conversation.',
      context: 'The shipment is late again and the customer had to call back.',
    });

    expect(result.extraction.overallEndUserSentiment?.score).toEqual({
      method: 'model_v1',
      score100: 15,
      score5: 1,
    });
  });
});
