import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { Server } from 'http';
import { ApiKeyAuthEntry, HttpAuthOptions } from '../auth/http-auth';
import { FileTenantAdminConfigRegistry } from '../admin/file-tenant-admin-config-registry';
import {
  ConversationIntelligenceServerOptions,
  startConversationIntelligenceServer,
} from '../api/http-server';
import { RlmCanonicalAnalysisEngine } from '../rlm/engine';
import { resolveProviderProfileFromEnv } from '../rlm/provider-profile';
import { PrometheusRuntimeObservability } from '../observability/prometheus-runtime-observability';
import { RuntimeObservability, noopRuntimeObservability } from '../observability/runtime-observability';
import { FileTenantPackRegistry } from '../packs/file-tenant-pack-registry';
import { AnalysisWorker } from '../service/analysis-worker';
import { CanaryAutomationService } from '../service/canary-automation-service';
import { CanaryAutomationWorker } from '../service/canary-automation-worker';
import { ConversationIntelligenceService } from '../service/conversation-intelligence-service';
import {
  CompositeValidationAlertNotifier,
  SlackValidationAlertNotifier,
  ValidationAlertNotifier,
  WebhookValidationAlertNotifier,
} from '../service/model-validation-alert-notifier';
import { ModelValidationService } from '../service/model-validation-service';
import { ModelValidationWorker } from '../service/model-validation-worker';
import { ReviewedRunExportRefreshService } from '../service/reviewed-run-export-refresh-service';
import { Pool } from 'pg';
import { PostgresJobStore } from '../store/postgres-job-store';
import { JobStore } from '../store/job-store';
import { SentimentStore } from '../store/sentiment-store';
import { PostgresSentimentStore } from '../store/postgres-sentiment-store';
import { SqliteSentimentStore } from '../store/sqlite-sentiment-store';
import { SqliteJobStore } from '../store/sqlite-job-store';
import { SentimentCalibrationService } from '../service/sentiment-calibration-service';
import { FileModelValidationReportStore } from '../validation/file-model-validation-report-store';

type ClosableStore = {
  close?(): Promise<void> | void;
};

export interface StandaloneConversationIntelligenceRuntime {
  store: JobStore;
  service: ConversationIntelligenceService;
  worker: AnalysisWorker;
  tenantPacks: FileTenantPackRegistry;
  tenantAdminConfigs: FileTenantAdminConfigRegistry;
  canaryAutomation: CanaryAutomationService | null;
  canaryWorker: CanaryAutomationWorker | null;
  validationReports: FileModelValidationReportStore;
  modelValidation: ModelValidationService;
  reviewedExports: ReviewedRunExportRefreshService | null;
  validationWorker: ModelValidationWorker | null;
  observability: RuntimeObservability;
  metrics: PrometheusRuntimeObservability | null;
  serverOptions: ConversationIntelligenceServerOptions;
  startServer(): Promise<Server>;
  close(): Promise<void>;
}

function parseOptionalNumber(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseJsonFileOrValue<T>(value: string | undefined, filePath: string | undefined): T | undefined {
  if (value) {
    return JSON.parse(value) as T;
  }

  if (filePath && existsSync(filePath)) {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  }

  return undefined;
}

function parseStringArray(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as string[];
  }

  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function resolveStandaloneAuthOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HttpAuthOptions {
  const mode = env.CI_AUTH_MODE ?? 'none';

  if (mode === 'api_key') {
    const apiKeys = parseJsonFileOrValue<ApiKeyAuthEntry[]>(
      env.CI_API_KEYS_JSON,
      env.CI_API_KEYS_FILE,
    ) ?? [];

    if (!apiKeys.length) {
      throw new Error('CI_AUTH_MODE=api_key requires CI_API_KEYS_JSON or CI_API_KEYS_FILE.');
    }

    return {
      mode: 'api_key',
      apiKeys,
    };
  }

  if (mode === 'trusted_proxy') {
    return {
      mode: 'trusted_proxy',
      tenantHeader: env.CI_TRUSTED_PROXY_TENANT_HEADER,
      principalHeader: env.CI_TRUSTED_PROXY_PRINCIPAL_HEADER,
      scopesHeader: env.CI_TRUSTED_PROXY_SCOPES_HEADER,
    };
  }

  return {
    mode: 'none',
  };
}

export async function createStandaloneConversationIntelligenceRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<StandaloneConversationIntelligenceRuntime> {
  const storeKind = env.CI_STORE ?? (env.DATABASE_URL ? 'postgres' : 'sqlite');
  if (storeKind === 'postgres' && !env.DATABASE_URL) {
    throw new Error('CI_STORE=postgres requires DATABASE_URL.');
  }

  let sharedPool: Pool | undefined;
  if (storeKind === 'postgres') {
    sharedPool = new Pool({ connectionString: env.DATABASE_URL });
  }

  const store = storeKind === 'postgres'
    ? new PostgresJobStore({ pool: sharedPool! })
    : new SqliteJobStore(
      env.CI_SQLITE_PATH
        ? resolve(cwd, env.CI_SQLITE_PATH)
        : resolve(cwd, 'data', 'conversation-intelligence.sqlite'),
    );

  await store.initialize();

  let sentimentStore: SentimentStore | undefined;
  if (sharedPool) {
    const pgSentimentStore = new PostgresSentimentStore({ pool: sharedPool });
    await pgSentimentStore.initialize();
    sentimentStore = pgSentimentStore;
  } else {
    // SQLite mode: use a co-located sentiment store alongside the job store
    const sqliteSentimentPath = env.CI_SQLITE_SENTIMENT_PATH
      ? resolve(cwd, env.CI_SQLITE_SENTIMENT_PATH)
      : resolve(cwd, 'data', 'sentiment.sqlite');
    const sqliteSentimentStore = new SqliteSentimentStore(sqliteSentimentPath);
    await sqliteSentimentStore.initialize();
    sentimentStore = sqliteSentimentStore;
  }

  const metricsEnabled = parseBoolean(env.CI_METRICS_ENABLED, true);
  const metrics = metricsEnabled ? new PrometheusRuntimeObservability() : null;
  const tenantPacks = new FileTenantPackRegistry(
    env.CI_TENANT_PACKS_DIR
      ? resolve(cwd, env.CI_TENANT_PACKS_DIR)
      : resolve(cwd, 'data', 'tenant-packs'),
  );
  await tenantPacks.initialize();
  const tenantAdminConfigs = new FileTenantAdminConfigRegistry(
    env.CI_TENANT_ADMIN_CONFIGS_DIR
      ? resolve(cwd, env.CI_TENANT_ADMIN_CONFIGS_DIR)
      : resolve(cwd, 'data', 'tenant-admin-configs'),
  );
  await tenantAdminConfigs.initialize();
  const observability = metrics ?? noopRuntimeObservability;
  const engine = new RlmCanonicalAnalysisEngine(resolveProviderProfileFromEnv(env));
  const service = new ConversationIntelligenceService({
    store,
    sentimentStore,
    engine,
    observability,
    tenantAdminConfigs,
  });
  const worker = new AnalysisWorker({
    service,
    pollIntervalMs: env.CI_WORKER_POLL_INTERVAL_MS ? Number(env.CI_WORKER_POLL_INTERVAL_MS) : 50,
  });
  const canaryAutomationEnabled = parseBoolean(env.CI_CANARY_AUTOMATION_ENABLED, true);
  const canaryAutomation = canaryAutomationEnabled
    ? new CanaryAutomationService({
      service,
      tenantPacks,
      tenantAdminConfigs,
    })
    : null;
  const canaryWorker = canaryAutomation
    ? new CanaryAutomationWorker({
      automation: canaryAutomation,
      intervalMs: env.CI_CANARY_AUTOMATION_INTERVAL_MS ? Number(env.CI_CANARY_AUTOMATION_INTERVAL_MS) : 60_000,
    })
    : null;
  const validationReports = new FileModelValidationReportStore(
    env.CI_MODEL_VALIDATION_REPORTS_DIR
      ? resolve(cwd, env.CI_MODEL_VALIDATION_REPORTS_DIR)
      : resolve(cwd, 'data', 'model-validation', 'reports'),
  );
  await validationReports.initialize();
  const reviewedExportOutputDir = env.CI_REVIEWED_EXPORT_OUTPUT_DIR
    ? resolve(cwd, env.CI_REVIEWED_EXPORT_OUTPUT_DIR)
    : (env.CI_MODEL_VALIDATION_DATA_DIR
      ? resolve(cwd, env.CI_MODEL_VALIDATION_DATA_DIR)
      : resolve(cwd, 'data', 'model-validation', 'reviewed'));
  const webhookUrls = parseStringArray(env.CI_VALIDATION_ALERT_WEBHOOK_URLS);
  const alertMinimumSeverity = (env.CI_VALIDATION_ALERT_MIN_SEVERITY as 'INFO' | 'WARNING' | 'CRITICAL' | undefined) ?? 'WARNING';
  const notifierChain: ValidationAlertNotifier[] = [];
  if (webhookUrls.length > 0) {
    notifierChain.push(new WebhookValidationAlertNotifier({
      webhookUrls,
      minimumSeverity: alertMinimumSeverity,
      observability,
    }));
  }
  if (env.CI_VALIDATION_ALERT_SLACK_WEBHOOK_URL) {
    notifierChain.push(new SlackValidationAlertNotifier({
      webhookUrl: env.CI_VALIDATION_ALERT_SLACK_WEBHOOK_URL,
      minimumSeverity: alertMinimumSeverity,
      observability,
    }));
  }
  const notifier = notifierChain.length > 0
    ? new CompositeValidationAlertNotifier(notifierChain)
    : undefined;
  const reviewedDatasetReadinessOverrides = {
    minimumRecordCount: parseOptionalNumber(env.CI_MODEL_VALIDATION_MIN_REVIEWED_RECORDS) ?? 10,
    minimumAnalystSentimentCount: parseOptionalNumber(env.CI_MODEL_VALIDATION_MIN_ANALYST_SENTIMENT_RECORDS) ?? 5,
    maximumDatasetAgeHours: parseOptionalNumber(env.CI_MODEL_VALIDATION_MAX_REVIEWED_DATASET_AGE_HOURS) ?? 168,
  };
  const modelValidation = new ModelValidationService({
    service,
    tenantPacks,
    tenantAdminConfigs,
    reportStore: validationReports,
    reviewedDataDir: reviewedExportOutputDir,
    reviewedDatasetReadinessOverrides,
    observability,
    notifier,
    cwd,
  });
  const reviewedExportsEnabled = parseBoolean(env.CI_REVIEWED_EXPORT_ENABLED, true);
  const reviewedExports = reviewedExportsEnabled
    ? new ReviewedRunExportRefreshService({
      validation: modelValidation,
      tenantAdminConfigs,
      outputDir: reviewedExportOutputDir,
      gzipSnapshots: parseBoolean(env.CI_REVIEWED_EXPORT_GZIP_SNAPSHOTS, true),
      writeManifest: parseBoolean(env.CI_REVIEWED_EXPORT_WRITE_MANIFESTS, true),
      policyOverrides: {
        includeTranscript: parseBoolean(env.CI_REVIEWED_EXPORT_INCLUDE_TRANSCRIPT, true),
        requireAnalystSentiment: parseBoolean(env.CI_REVIEWED_EXPORT_REQUIRE_ANALYST_SENTIMENT, false),
        classification: env.CI_REVIEWED_EXPORT_CLASSIFICATION === 'INTERNAL' ? 'INTERNAL' : 'RESTRICTED',
        retentionDays: parseOptionalNumber(env.CI_REVIEWED_EXPORT_RETENTION_DAYS) ?? 30,
        maximumSnapshots: parseOptionalNumber(env.CI_REVIEWED_EXPORT_MAX_SNAPSHOTS) ?? 30,
      },
      readinessOverrides: reviewedDatasetReadinessOverrides,
      observability,
    })
    : null;
  const validationEnabled = parseBoolean(env.CI_MODEL_VALIDATION_ENABLED, true);
  const validationWorker = validationEnabled
    ? new ModelValidationWorker({
      validation: modelValidation,
      intervalMs: env.CI_MODEL_VALIDATION_INTERVAL_MS ? Number(env.CI_MODEL_VALIDATION_INTERVAL_MS) : 24 * 60 * 60 * 1000,
      beforeRun: reviewedExports
        ? async () => {
          await reviewedExports.refreshConfiguredExports();
          await modelValidation.applyConfiguredThresholdRecommendations();
        }
        : async () => {
          await modelValidation.applyConfiguredThresholdRecommendations();
        },
    })
    : null;
  const sentimentCalibration = sentimentStore
    ? new SentimentCalibrationService(sentimentStore, observability)
    : undefined;
  const auth = resolveStandaloneAuthOptionsFromEnv(env);
  const serverOptions: ConversationIntelligenceServerOptions = {
    port: env.PORT ? Number(env.PORT) : 8787,
    auth,
    ssePollIntervalMs: env.CI_SSE_POLL_INTERVAL_MS ? Number(env.CI_SSE_POLL_INTERVAL_MS) : 100,
    ui: {
      enabled: parseBoolean(env.CI_UI_ENABLED, true),
      path: env.CI_UI_PATH ?? '/app',
      title: env.CI_UI_TITLE ?? 'Conversation Intelligence Console',
    },
    metrics: metrics
      ? {
        exporter: metrics,
        path: env.CI_METRICS_PATH ?? '/metrics',
      }
      : undefined,
    tenantPacks,
    tenantAdminConfigs,
    modelValidation: {
      service: modelValidation,
      reviewedExports: reviewedExports ?? undefined,
    },
    sentimentStore,
    sentimentCalibration,
  };

  return {
    store,
    service,
    worker,
    tenantPacks,
    tenantAdminConfigs,
    canaryAutomation,
    canaryWorker,
    validationReports,
    modelValidation,
    reviewedExports,
    validationWorker,
    observability,
    metrics,
    serverOptions,
    startServer: async (): Promise<Server> => {
      worker.start();
      canaryWorker?.start();
      validationWorker?.start();
      return startConversationIntelligenceServer(service, serverOptions);
    },
    close: async (): Promise<void> => {
      if (validationWorker) {
        await validationWorker.stop();
      }
      if (canaryWorker) {
        await canaryWorker.stop();
      }
      await worker.stop();
      const closableStore = store as JobStore & ClosableStore;
      if (closableStore.close) {
        await closableStore.close();
      }
      const closableSentiment = sentimentStore as (SentimentStore & ClosableStore) | undefined;
      if (closableSentiment?.close) {
        await closableSentiment.close();
      }
    },
  };
}
