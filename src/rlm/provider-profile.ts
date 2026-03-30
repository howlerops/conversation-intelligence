import { RlmConversationEngineConfig } from './engine';

export interface ResolvedProviderProfile extends RlmConversationEngineConfig {
  provider: 'openai-compatible' | 'ollama';
}

export function normalizeOpenAiCompatibleBaseUrl(raw: string): string {
  return raw.endsWith('/v1') ? raw : `${raw.replace(/\/$/, '')}/v1`;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return undefined;
  }
}

export function resolveProviderProfileFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProviderProfile {
  const provider = env.CI_PROVIDER === 'ollama' || env.OLLAMA_BASE_URL || env.OLLAMA_MODEL
    ? 'ollama'
    : 'openai-compatible';

  if (provider === 'ollama') {
    const baseUrl = normalizeOpenAiCompatibleBaseUrl(
      env.OLLAMA_BASE_URL
        ?? env.OPENAI_API_BASE
        ?? 'http://localhost:11434',
    );
    const maxTokens = parseOptionalNumber(env.CI_RLM_MAX_TOKENS) ?? 4096;
    const reasoningEffort = env.CI_RLM_REASONING_EFFORT ?? 'none';

    return {
      provider: 'ollama',
      mode: env.CI_RLM_MODE === 'structured' ? 'structured' : 'ollama_json_compat',
      model: env.CI_RLM_MODEL ?? env.OLLAMA_MODEL ?? 'qwen3.5',
      apiBase: baseUrl,
      apiKey: env.OLLAMA_API_KEY ?? env.OPENAI_API_KEY ?? 'ollama',
      goBinaryPath: env.RLM_GO_BINARY,
      maxDepth: parseOptionalNumber(env.CI_RLM_MAX_DEPTH) ?? 2,
      maxIterations: parseOptionalNumber(env.CI_RLM_MAX_ITERATIONS) ?? 10,
      maxTokens,
      timeoutSeconds: parseOptionalNumber(env.CI_RLM_TIMEOUT_SECONDS),
      requestTimeoutMs: parseOptionalNumber(env.CI_RLM_REQUEST_TIMEOUT_MS),
      temperature: parseOptionalNumber(env.CI_RLM_TEMPERATURE) ?? 0,
      structuredMaxRetries: parseOptionalNumber(env.CI_RLM_STRUCTURED_MAX_RETRIES),
      parallelExecution: parseOptionalBoolean(env.CI_RLM_PARALLEL_EXECUTION),
      debug: parseOptionalBoolean(env.CI_RLM_DEBUG),
      logOutput: env.CI_RLM_LOG_OUTPUT,
      extraParams: {
        reasoning_effort: reasoningEffort,
        // Disable extended thinking for qwen3 models — prevents multi-minute
        // token generation that makes each record unacceptably slow.
        think: false,
      },
    };
  }

  const model = env.CI_RLM_MODEL ?? 'gpt-4o-mini';
  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY must be set for openai-compatible provider mode.');
  }

  return {
    provider: 'openai-compatible',
    mode: env.CI_RLM_MODE === 'ollama_json_compat' ? 'ollama_json_compat' : 'structured',
    model,
    apiBase: env.OPENAI_API_BASE,
    apiKey,
    goBinaryPath: env.RLM_GO_BINARY,
    maxDepth: parseOptionalNumber(env.CI_RLM_MAX_DEPTH) ?? 2,
    maxIterations: parseOptionalNumber(env.CI_RLM_MAX_ITERATIONS) ?? 10,
    maxTokens: parseOptionalNumber(env.CI_RLM_MAX_TOKENS),
    timeoutSeconds: parseOptionalNumber(env.CI_RLM_TIMEOUT_SECONDS),
    requestTimeoutMs: parseOptionalNumber(env.CI_RLM_REQUEST_TIMEOUT_MS),
    temperature: parseOptionalNumber(env.CI_RLM_TEMPERATURE) ?? 0,
    structuredMaxRetries: parseOptionalNumber(env.CI_RLM_STRUCTURED_MAX_RETRIES),
    parallelExecution: parseOptionalBoolean(env.CI_RLM_PARALLEL_EXECUTION),
    debug: parseOptionalBoolean(env.CI_RLM_DEBUG),
    logOutput: env.CI_RLM_LOG_OUTPUT,
  };
}
