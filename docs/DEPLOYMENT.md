# Deployment Modes

This runtime is intentionally shaped to work in two low-overhead modes:

- standalone app: one process with API, worker, optional UI shell, and SQLite or Postgres
- embedded runtime: imported directly into an existing Node service or job runner

## Standalone App

Use the env-driven bootstrap in `/Users/jacob/projects/conversation-intelligence-repo/examples/start-server.ts`.

Typical local Ollama launch:

```bash
CI_PROVIDER=ollama \
OLLAMA_BASE_URL=http://localhost:11434 \
OLLAMA_MODEL=qwen3.5 \
CI_STORE=sqlite \
CI_SQLITE_PATH=data/conversation-intelligence.sqlite \
CI_TENANT_ADMIN_CONFIGS_DIR=data/tenant-admin-configs \
CI_CANARY_AUTOMATION_ENABLED=true \
CI_REVIEWED_EXPORT_ENABLED=true \
CI_REVIEWED_EXPORT_OUTPUT_DIR=/absolute/path/outside/repo/reviewed-exports \
CI_REVIEWED_EXPORT_GZIP_SNAPSHOTS=true \
CI_REVIEWED_EXPORT_WRITE_MANIFESTS=true \
CI_REVIEWED_EXPORT_INCLUDE_TRANSCRIPT=true \
CI_REVIEWED_EXPORT_REQUIRE_ANALYST_SENTIMENT=false \
CI_REVIEWED_EXPORT_CLASSIFICATION=RESTRICTED \
CI_REVIEWED_EXPORT_RETENTION_DAYS=30 \
CI_REVIEWED_EXPORT_MAX_SNAPSHOTS=30 \
CI_MODEL_VALIDATION_ENABLED=true \
CI_MODEL_VALIDATION_DATA_DIR=/absolute/path/outside/repo/reviewed-exports \
CI_MODEL_VALIDATION_REPORTS_DIR=data/model-validation/reports \
CI_MODEL_VALIDATION_MIN_REVIEWED_RECORDS=10 \
CI_MODEL_VALIDATION_MIN_ANALYST_SENTIMENT_RECORDS=5 \
CI_MODEL_VALIDATION_MAX_REVIEWED_DATASET_AGE_HOURS=168 \
CI_VALIDATION_ALERT_WEBHOOK_URLS='["https://alerts.example.internal/conversation-intelligence"]' \
CI_VALIDATION_ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... \
CI_UI_ENABLED=true \
CI_METRICS_ENABLED=true \
npm run serve:standalone
```

Important endpoints:

- `/app` - self-hosted run console
- `/metrics` - Prometheus-style metrics
- `/v1/runs` - run creation and listing
- `/v1/runs/:id/events` - persisted event timeline
- `/v1/runs/:id/audit` - persisted audit timeline for one run
- `/v1/runs/:id/stream` - live SSE stream for internal tooling
- `/v1/review-analytics` - analyst queue metrics
- `/v1/schema/v1` - current schema registry payload
- `/v1/tenant-admin/config` - tenant admin config for SLA, assignment policy, canary automation, and validation monitoring
- `/v1/model-validation/refresh-reviewed-exports` - refresh the redacted reviewed dataset in the configured secure output path
- `/v1/model-validation/export-reviewed-runs` - NDJSON export for redacted reviewed holdout sets
- `/v1/model-validation/reviewed-datasets` - inspected reviewed dataset coverage for the current tenant/use-case scope
- `/v1/model-validation/run` - generate validation reports on demand
- `/v1/model-validation/reports` - persisted validation report history
- `/v1/model-validation/alerts` - current persisted validation alerts
- `/v1/model-validation/recommend-thresholds` - recommend tenant-specific validation thresholds from current live and reviewed data
- `/v1/model-validation/apply-recommended-thresholds` - update tenant validation thresholds and nightly validation cadence from the current recommendation
- `/v1/tenant-packs/active` - current active pack plus version inventory
- `/v1/tenant-packs/*` - validate, preview, publish, approve, comment, evaluate-canary, auto-evaluate-canary, promote, and rollback admin APIs

For production, move from SQLite to Postgres:

```bash
CI_STORE=postgres \
DATABASE_URL=postgres://user:pass@host:5432/conversation_intelligence \
npm run serve:standalone
```

Auth modes:

- `CI_AUTH_MODE=none`
- `CI_AUTH_MODE=api_key` with `CI_API_KEYS_JSON` or `CI_API_KEYS_FILE`
- `CI_AUTH_MODE=trusted_proxy` with the `CI_TRUSTED_PROXY_*` header names

For OIDC-backed production environments, terminate OIDC at the gateway and forward trusted identity headers into this service. See `/Users/jacob/projects/conversation-intelligence-repo/docs/AUTH.md`.

Validation-specific env knobs:

- `CI_REVIEWED_EXPORT_ENABLED`
- `CI_REVIEWED_EXPORT_OUTPUT_DIR`
- `CI_REVIEWED_EXPORT_GZIP_SNAPSHOTS`
- `CI_REVIEWED_EXPORT_WRITE_MANIFESTS`
- `CI_REVIEWED_EXPORT_INCLUDE_TRANSCRIPT`
- `CI_REVIEWED_EXPORT_REQUIRE_ANALYST_SENTIMENT`
- `CI_REVIEWED_EXPORT_CLASSIFICATION`
- `CI_REVIEWED_EXPORT_RETENTION_DAYS`
- `CI_REVIEWED_EXPORT_MAX_SNAPSHOTS`
- `CI_MODEL_VALIDATION_ENABLED`
- `CI_MODEL_VALIDATION_INTERVAL_MS`
- `CI_MODEL_VALIDATION_DATA_DIR`
- `CI_MODEL_VALIDATION_REPORTS_DIR`
- `CI_MODEL_VALIDATION_MIN_REVIEWED_RECORDS`
- `CI_MODEL_VALIDATION_MIN_ANALYST_SENTIMENT_RECORDS`
- `CI_MODEL_VALIDATION_MAX_REVIEWED_DATASET_AGE_HOURS`
- `CI_VALIDATION_ALERT_WEBHOOK_URLS`
- `CI_VALIDATION_ALERT_SLACK_WEBHOOK_URL`
- `CI_VALIDATION_ALERT_MIN_SEVERITY`

For production reviewed-export handling:

- prefer compressed timestamped snapshots plus per-scope manifest files
- keep the reviewed export directory outside the repo and outside ephemeral container layers
- use `CI_REVIEWED_EXPORT_INCLUDE_TRANSCRIPT=false` unless a reviewed-export benchmark loop explicitly needs transcript text
- keep `CI_REVIEWED_EXPORT_CLASSIFICATION` aligned with your internal data-handling tier
- set retention and snapshot-count caps so export trees prune automatically instead of growing without bound

The manifest now carries hashes, coverage counts, classification, transcript-inclusion state, and readiness failures for the latest refresh so nightly validation can fail fast when the dataset unexpectedly changes shape or freshness.

## Embedded Runtime

Use the service and worker directly when you want this installed alongside an existing app without exposing the built-in HTTP shell.

Minimal pattern:

```ts
const store = new SqliteJobStore('/absolute/path/to/jobs.sqlite');
await store.initialize();

const service = new ConversationIntelligenceService({
  store,
  engine: new RlmCanonicalAnalysisEngine(resolveProviderProfileFromEnv(process.env)),
});

const worker = new AnalysisWorker({ service });
worker.start();

const queued = await service.submitJob({
  transcript,
  tenantPack,
});
```

See `/Users/jacob/projects/conversation-intelligence-repo/examples/embedded-runtime.ts` for a complete runnable example.

## Packaging Note

This repo currently depends on the local sibling checkout of `recursive-llm-ts`. That keeps upstream changes easy while the runtime surface is still moving, but it also means the cleanest current install flows are source-based Node launches rather than a fully sealed container image.

Once the RLM dependency is packaged more cleanly, the standalone bootstrap here is already ready to back a container or system package without changing the app/runtime contract. Until then, treat source-based installs as the primary supported path.
