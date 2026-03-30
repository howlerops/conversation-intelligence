import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStandaloneConversationIntelligenceRuntimeFromEnv } from '../src';

describe('createStandaloneConversationIntelligenceRuntimeFromEnv', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((path) => rm(path, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('builds a low-overhead standalone runtime from env for SQLite, UI, metrics, and API-key auth', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-standalone-'));
    tempDirs.push(rootDir);

    const runtime = await createStandaloneConversationIntelligenceRuntimeFromEnv({
      CI_PROVIDER: 'ollama',
      OLLAMA_BASE_URL: 'http://localhost:11434',
      OLLAMA_MODEL: 'qwen3.5',
      CI_STORE: 'sqlite',
      CI_SQLITE_PATH: 'data/runtime.sqlite',
      CI_AUTH_MODE: 'api_key',
      CI_API_KEYS_JSON: JSON.stringify([
        {
          token: 'token-standalone',
          tenantId: 'tenant_support_acme',
          principalId: 'svc_standalone',
        },
      ]),
      CI_UI_ENABLED: 'true',
      CI_METRICS_ENABLED: 'true',
      CI_REVIEWED_EXPORT_ENABLED: 'true',
      CI_REVIEWED_EXPORT_OUTPUT_DIR: 'secure/reviewed',
      CI_VALIDATION_ALERT_WEBHOOK_URLS: 'http://127.0.0.1:9999/alerts',
      CI_VALIDATION_ALERT_SLACK_WEBHOOK_URL: 'http://127.0.0.1:9999/slack',
      PORT: '9911',
    }, rootDir);

    try {
      expect(runtime.metrics).not.toBeNull();
      expect(runtime.modelValidation).toBeDefined();
      expect(runtime.reviewedExports).not.toBeNull();
      expect(runtime.validationReports).toBeDefined();
      expect(runtime.serverOptions.port).toBe(9911);
      expect(runtime.serverOptions.ui?.enabled).toBe(true);
      expect(runtime.serverOptions.metrics?.path).toBe('/metrics');
      expect(runtime.serverOptions.auth?.mode).toBe('api_key');
      expect(runtime.serverOptions.auth?.apiKeys?.[0]?.tenantId).toBe('tenant_support_acme');
    } finally {
      await runtime.close();
    }
  });
});
