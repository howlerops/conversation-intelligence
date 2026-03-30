import { describe, expect, it } from 'vitest';
import { normalizeOpenAiCompatibleBaseUrl, resolveProviderProfileFromEnv } from '../src';

describe('provider profiles', () => {
  it('normalizes Ollama base URLs to the OpenAI-compatible /v1 path', () => {
    expect(normalizeOpenAiCompatibleBaseUrl('http://localhost:11434')).toBe('http://localhost:11434/v1');
    expect(normalizeOpenAiCompatibleBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
  });

  it('resolves an Ollama profile without requiring OpenAI credentials', () => {
    const profile = resolveProviderProfileFromEnv({
      CI_PROVIDER: 'ollama',
      OLLAMA_BASE_URL: 'http://localhost:11434',
      OLLAMA_MODEL: 'qwen3.5',
      CI_RLM_TIMEOUT_SECONDS: '45',
      CI_RLM_REQUEST_TIMEOUT_MS: '90000',
      CI_RLM_STRUCTURED_MAX_RETRIES: '1',
      CI_RLM_PARALLEL_EXECUTION: 'false',
      CI_RLM_MAX_TOKENS: '512',
    });

    expect(profile.provider).toBe('ollama');
    expect(profile.mode).toBe('ollama_json_compat');
    expect(profile.apiBase).toBe('http://localhost:11434/v1');
    expect(profile.apiKey).toBe('ollama');
    expect(profile.model).toBe('qwen3.5');
    expect(profile.timeoutSeconds).toBe(45);
    expect(profile.requestTimeoutMs).toBe(90000);
    expect(profile.structuredMaxRetries).toBe(1);
    expect(profile.parallelExecution).toBe(false);
    expect(profile.maxTokens).toBe(512);
    expect(profile.extraParams).toEqual({ reasoning_effort: 'none', think: false });
  });

  it('requires an API key for openai-compatible mode', () => {
    expect(() => resolveProviderProfileFromEnv({
      CI_PROVIDER: 'openai-compatible',
      CI_RLM_MODEL: 'gpt-4o-mini',
    })).toThrow('OPENAI_API_KEY must be set');
  });
});
