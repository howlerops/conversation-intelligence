# Conversation Intelligence

Production-first scaffold for a speaker-aware conversation intelligence system built around `recursive-llm-ts`.

This repo started as a docs handoff. It now includes the first executable foundation for the v0 production slice:

- canonical transcript, tenant-pack, and analysis contracts
- transcript normalization
- deterministic speaker resolution and role gating
- tenant event mapping
- review-oriented verification
- SQLite-backed job persistence
- Postgres-backed job persistence
- a polling worker for queued analysis
- run-event and audit-event tracking for workflow visibility
- auth, tenant scoping, and audit hooks at the HTTP boundary
- configurable PII masking with request-level regex rules and service-level custom maskers
- optional metrics/tracing hooks around run lifecycle and engine execution
- a self-hosted run console for internal or customer-facing workflow visibility
- analyst assignment, review actions, analytics, filtering, and bulk actions for queued review items
- analyst comments, SLA visibility, and audit-event visualization in the built-in console
- tenant admin config for review SLA, assignment policy, canary automation, and validation monitoring
- tenant-pack management inside the built-in console
- tenant-pack validate, preview, publish, approve, comment, evaluate-canary, auto-evaluate-canary, promote, and rollback APIs
- tenant-pack active-state inspection
- lightweight approval, release history, automated canary evaluation, and rollback controls for pack releases
- a schema registry endpoint for current runtime contracts
- derived `score100` and `score5` sentiment scoring for the overall end-user sentiment
- reviewed sentiment calibration fixtures with tolerance-based scoring checks
- reviewed sentiment outcome validation against analyst labels
- engagement-specific sentiment score calibration recommendations and runtime offsets
- scheduled reviewed-run export refresh to a secure external dataset path
- reviewed dataset inventory for larger real-data validation trees
- gzip-compressed reviewed-export snapshots with integrity manifests
- batch validation reports with schema-valid and latency regression summaries
- threshold recommendation tooling for tenant-specific validation tuning
- threshold application tooling that can enable nightly shadow validation on tenant admin configs
- persisted validation alerts plus webhook and Slack delivery
- queue- and transcript-length-scoped validation alerts
- validation dashboards inside the built-in console
- Prometheus-facing validation gauges for global and scoped metrics
- spec-driven public-data test pipelines for call, email, and ticket engagements
- engagement-type drift breakdowns in persisted validation reports
- queue and transcript-length breakdowns in persisted validation reports
- comparison tooling between public offline slices and tenant shadow-validation exports
- an RLM-backed analysis engine adapter
- unit, fixture-eval, and live HTTP integration tests for the initial support workflow

The design docs from the original thread are still preserved in `/Users/jacob/projects/conversation-intelligence-repo/docs`.

## Current Scope

The implemented slice is intentionally narrow:

- support transcripts only
- text only
- English only
- post-call analysis
- END_USER-only sentiment and key moments by default
- RLM required as the canonical extraction engine for real analysis runs

## Local Dependency

This repo currently depends on the local RLM package at:

- `/Users/jacob/projects/recursive-llm-ts`

That dependency is installed with:

```bash
npm install
```

Because the linked package builds a Go binary during install, you need a working Go toolchain locally. This machine already has one.

## Quick Start

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Run fixture evals:

```bash
npm run eval:fixtures
```

Run sentiment calibration:

```bash
npm run eval:sentiment
```

Run reviewed sentiment validation:

```bash
npm run eval:sentiment:reviewed
```

Recommend engagement-specific sentiment scoring offsets from reviewed data:

```bash
npm run recommend:sentiment-scoring -- fixtures/sentiment-reviewed-outcomes.support.json
```

Run the end-to-end benchmark harness against the public engagement suite:

```bash
CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 CI_RLM_MAX_DEPTH=1 CI_RLM_MAX_ITERATIONS=1 CI_RLM_TIMEOUT_SECONDS=45 npm run benchmark:e2e:isolated -- fixtures/benchmarks/e2e-smoke-suite.json /tmp/conversation-intelligence-e2e-smoke --concurrency 1 --max-records-per-source 1 --per-record-timeout-ms 90000 --child-timeout-ms 100000
```

Run the E2E improvement loop with reviewed-data-driven calibration:

```bash
CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 CI_RLM_MAX_DEPTH=1 CI_RLM_MAX_ITERATIONS=1 CI_RLM_TIMEOUT_SECONDS=45 npm run loop:e2e:isolated -- fixtures/benchmarks/e2e-smoke-suite.json /tmp/conversation-intelligence-loop --reviewed-dataset fixtures/sentiment-reviewed-outcomes.support.json --concurrency 1 --max-records-per-source 1 --per-record-timeout-ms 90000 --child-timeout-ms 100000
```

Run the larger public-engagement loop with benchmark-derived calibration:

```bash
CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 CI_RLM_MAX_DEPTH=1 CI_RLM_MAX_ITERATIONS=1 CI_RLM_TIMEOUT_SECONDS=45 npm run loop:e2e:isolated -- fixtures/benchmarks/e2e-large-suite.json /tmp/conversation-intelligence-loop-large --calibration-source benchmark --concurrency 1 --per-record-timeout-ms 90000 --child-timeout-ms 100000
```

Run the repeated-trial matrix when you need provider-stability evidence instead of a single loop sample:

```bash
CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 CI_RLM_MAX_DEPTH=1 CI_RLM_MAX_ITERATIONS=1 CI_RLM_TIMEOUT_SECONDS=45 npm run loop:e2e:trial-matrix:isolated -- fixtures/benchmarks/e2e-large-suite.json /tmp/conversation-intelligence-trial-matrix-large --trials 3 --calibration-source benchmark --concurrency 1 --per-record-timeout-ms 90000 --child-timeout-ms 100000
```

Use `benchmark:e2e` / `loop:e2e` for in-process runs on stronger hosted models. Use `benchmark:e2e:isolated` / `loop:e2e:isolated` for local Ollama runs so each record is killable and leaves per-record child logs under the output directory.

Run the real-data reviewed-export loop when you want large-scale calibration and drift evidence from secure analyst-reviewed trees:

```bash
CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 CI_RLM_MAX_DEPTH=1 CI_RLM_MAX_ITERATIONS=1 CI_RLM_TIMEOUT_SECONDS=45 npm run loop:e2e:reviewed -- /absolute/path/reviewed-exports/tenant_acme/support /absolute/path/tenant-pack.support.acme.json /tmp/conversation-intelligence-reviewed-loop --mode isolated --calibration-source reviewed --concurrency 1 --per-record-timeout-ms 90000 --child-timeout-ms 100000
```

That flow writes `reviewed-dataset-summary.json`, a generated suite file, and the usual baseline/calibrated loop artifacts under the output directory.

Build a reviewed-style benchmark dataset from the labeled public suites:

```bash
npm run build:reviewed-benchmark -- /tmp/conversation-intelligence-reviewed-benchmark
```

Generate draft annotations for the unlabeled benchmark backlog so a human can review and promote them into the benchmark corpus:

```bash
CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 CI_RLM_MAX_DEPTH=1 CI_RLM_MAX_ITERATIONS=1 CI_RLM_TIMEOUT_SECONDS=45 npm run annotate:reviewed-benchmark -- /tmp/conversation-intelligence-reviewed-benchmark-with-annotations/annotation-candidates.jsonl /tmp/conversation-intelligence-reviewed-benchmark-drafts --tenant-pack fixtures/tenant-pack.support.acme.json --trials 3 --concurrency 1 --per-record-timeout-ms 90000
```

That writes `draft-annotation-summary.json`, `draft-annotation-report.json`, `draft-annotations.jsonl`, and `draft-annotation-review.md`. These are review drafts only; they are not gold benchmark labels until a human accepts or corrects them.

Run the reviewed benchmark loop against that generated reviewed-export tree:

```bash
CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 CI_RLM_MAX_DEPTH=1 CI_RLM_MAX_ITERATIONS=1 CI_RLM_TIMEOUT_SECONDS=45 npm run loop:e2e:public-reviewed -- /tmp/conversation-intelligence-public-reviewed --mode isolated --concurrency 1 --per-record-timeout-ms 90000 --child-timeout-ms 100000
```

Run the large-scale mixed public benchmark when you need real public CALL/TICKET traffic, larger synthetic EMAIL traffic, and reviewed holdouts in one isolated loop:

```bash
CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 CI_RLM_MAX_DEPTH=1 CI_RLM_MAX_ITERATIONS=1 CI_RLM_TIMEOUT_SECONDS=45 npm run loop:e2e:public-scale:isolated -- /tmp/conversation-intelligence-public-scale-large --call-limit 12 --ticket-limit 12 --email-limit 12 --concurrency 1 --per-record-timeout-ms 90000 --child-timeout-ms 100000
```

That flow downloads and caches the raw public corpora under `raw/`, builds a generated scale manifest under `data/`, writes an `e2e-public-scale-suite.json`, and then runs the same isolated baseline/calibrated loop against the combined scale + reviewed benchmark suite.

The isolated loop now writes:

- baseline and calibrated `summary.json` / `records.jsonl`
- `loop-report.json` with gate failures, worst-record lists, and the selected calibration source
- `recommended-sentiment-calibration.json` when the loop can derive a config from reviewed data or the benchmark records themselves
- trial-matrix `executions.json`, `summary.json`, and `progress.jsonl` when repeated provider runs are needed

Current local Ollama signal from the March 29, 2026 large-suite loop:

- single calibrated large-suite run reached `averageDeltaScore100=2.36`
- single calibrated large-suite run reached `withinFivePointsRate=1.0`
- repeated 3-trial matrix reached `passRate=1.0` for both baseline and calibrated runs
- repeated 3-trial matrix was deterministic on score quality: calibrated `averageDeltaScore100=2.36`, `withinFivePointsRate=1.0`
- the remaining scale work is now real reviewed-export validation, not public-suite drift closure

Export reviewed runs as NDJSON:

```bash
CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 npm run export:reviewed-runs -- --tenant tenant_acme --use-case support --out /tmp/reviewed-support.jsonl
```

Refresh reviewed exports into the configured validation dataset path:

```bash
CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 CI_REVIEWED_EXPORT_OUTPUT_DIR=/tmp/reviewed npm run refresh:reviewed-runs -- --tenant tenant_acme --use-case support --force
```

Inspect reviewed dataset coverage before running validation:

```bash
CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 CI_MODEL_VALIDATION_DATA_DIR=/tmp/reviewed npm run inspect:reviewed-datasets -- --tenant tenant_acme --use-case support
```

Run model validation reports:

```bash
CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 npm run validate:model -- --tenant tenant_acme --use-case support --force
```

Recommend tenant validation thresholds from current reviewed/live data:

```bash
CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 npm run recommend:validation-thresholds -- --tenant tenant_acme --use-case support --pack-version support-v2
```

Apply recommended thresholds to a tenant config and set nightly shadow validation:

```bash
CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 npm run apply:validation-thresholds -- --tenant tenant_acme --use-case support --pack-version support-v2 --nightly-interval-minutes 1440 --minimum-run-count 50 --minimum-reviewed-sample-size 20 --minimum-run-count-per-engagement 15 --minimum-reviewed-sample-size-per-engagement 8 --auto-apply
```

Build the spec-driven public-data test pipelines:

```bash
npm run build:public-test-pipelines
```

Compare public offline slices to tenant shadow-validation exports:

```bash
npm run compare:public-shadow -- --public-path eval-data/public --shadow-path /absolute/path/reviewed-exports/tenant_acme/support.jsonl
```

Both reviewed validation and public-vs-shadow comparison now accept either a single JSON/JSONL file or a directory tree of snapshot files.

Reviewed exports and reviewed validation inputs can also be stored as `.json.gz`, `.jsonl.gz`, or `.ndjson.gz` snapshots for larger datasets.

Build the GitHub Pages docs site:

```bash
npm run docs:build
```

Preview the docs locally:

```bash
npm run docs:dev
```

Type-check:

```bash
npm run typecheck
```

Build:

```bash
npm run build
```

Start the local API server:

```bash
CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 npm run serve:dev
```

Start the standalone app shell with UI and metrics:

```bash
CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 npm run serve:standalone
```

Run the example fixture through RLM:

```bash
CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 npm run analyze:fixture
```

Run the embedded-mode queued example:

```bash
CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 npm run embedded:fixture
```

Optional environment variables:

- `CI_PROVIDER` - `openai-compatible` or `ollama`
- `CI_STORE` - `sqlite` or `postgres`
- `CI_SQLITE_PATH` - SQLite file path for standalone mode
- `DATABASE_URL` - Postgres connection string
- `CI_AUTH_MODE` - `none`, `api_key`, or `trusted_proxy`
- `CI_API_KEYS_JSON` - JSON array of API key entries for lightweight installs
- `CI_RLM_MODEL` - overrides the resolved model
- `CI_RLM_MODE` - `structured` or `ollama_json_compat`; Ollama defaults to the compatibility path
- `CI_RLM_MAX_TOKENS` - caps generated tokens for local/provider tuning
- `CI_RLM_TIMEOUT_SECONDS` - per-request provider timeout
- `CI_RLM_REQUEST_TIMEOUT_MS` - local abort timer for in-process runs
- `CI_RLM_REASONING_EFFORT` - OpenAI-compatible reasoning control; Ollama defaults to `none`
- `OPENAI_API_BASE` - custom OpenAI-compatible endpoint
- `OLLAMA_BASE_URL` - local Ollama base URL before `/v1` normalization
- `OLLAMA_MODEL` - local Ollama model name
- `OLLAMA_API_KEY` - optional dummy key for Ollama compatibility
- `CI_UI_ENABLED` - enables the built-in run console
- `CI_METRICS_ENABLED` - enables Prometheus-style metrics export
- `CI_CANARY_AUTOMATION_ENABLED` - enables periodic canary evaluation
- `CI_CANARY_AUTOMATION_INTERVAL_MS` - canary evaluation cadence
- `CI_REVIEWED_EXPORT_ENABLED` - enables periodic reviewed-export refresh ahead of validation runs
- `CI_REVIEWED_EXPORT_OUTPUT_DIR` - secure dataset path for refreshed reviewed exports
- `CI_REVIEWED_EXPORT_GZIP_SNAPSHOTS` - writes timestamped reviewed snapshots as `.jsonl.gz`
- `CI_REVIEWED_EXPORT_WRITE_MANIFESTS` - writes per-scope manifest files with hashes and coverage counts
- `CI_REVIEWED_EXPORT_INCLUDE_TRANSCRIPT` - globally force transcript inclusion on or off for refreshed reviewed exports
- `CI_REVIEWED_EXPORT_REQUIRE_ANALYST_SENTIMENT` - restrict refreshed exports to runs with analyst sentiment labels
- `CI_REVIEWED_EXPORT_CLASSIFICATION` - `RESTRICTED` or `INTERNAL` manifest classification for reviewed exports
- `CI_REVIEWED_EXPORT_RETENTION_DAYS` - snapshot retention window for reviewed-export pruning
- `CI_REVIEWED_EXPORT_MAX_SNAPSHOTS` - maximum retained snapshots per tenant/use-case scope
- `CI_MODEL_VALIDATION_ENABLED` - enables periodic model-validation runs
- `CI_MODEL_VALIDATION_INTERVAL_MS` - model-validation cadence
- `CI_MODEL_VALIDATION_DATA_DIR` - reviewed export directory for nightly validation
- `CI_MODEL_VALIDATION_REPORTS_DIR` - persisted validation report directory
- `CI_MODEL_VALIDATION_MIN_REVIEWED_RECORDS` - global readiness floor before nightly validation runs
- `CI_MODEL_VALIDATION_MIN_ANALYST_SENTIMENT_RECORDS` - analyst-label readiness floor before nightly validation runs
- `CI_MODEL_VALIDATION_MAX_REVIEWED_DATASET_AGE_HOURS` - freshness guardrail for nightly validation datasets
- `CI_VALIDATION_ALERT_WEBHOOK_URLS` - comma-separated or JSON array of webhook URLs for validation alerts
- `CI_VALIDATION_ALERT_SLACK_WEBHOOK_URL` - Slack incoming webhook for validation alerts
- `CI_VALIDATION_ALERT_MIN_SEVERITY` - minimum alert severity delivered to webhooks
- `RLM_GO_BINARY` - override the Go binary path for `recursive-llm-ts`

## Repo Layout

```text
docs/       original PRD, architecture, and playbook
fixtures/   starter tenant packs and transcripts
examples/   runnable examples
src/        contracts, pipeline, and RLM integration
test/       unit tests for the v0 slice
data/       local SQLite job store created by the example server
```

## Implemented Modules

- `/Users/jacob/projects/conversation-intelligence-repo/src/contracts`
  - transcript input contract
  - tenant-pack contract
  - canonical analysis contract
- `/Users/jacob/projects/conversation-intelligence-repo/src/pipeline`
  - normalization
  - speaker resolution
  - tenant mapping
  - verification
  - top-level orchestration
- `/Users/jacob/projects/conversation-intelligence-repo/src/rlm`
  - prompt construction
  - RLM engine adapter

## Supported Runtime Modes

The runtime is being shaped to support both standalone and install-alongside deployments:

- embedded: consume the runtime directly inside an existing Node service
- single-service: one process with API + worker + SQLite or Postgres
- split-service: API + worker processes against Postgres
- optional UI shell: customer-facing run visibility without exposing raw workflow internals

The standalone shell is now real:

- `/app` serves the built-in run console
- `/metrics` serves Prometheus-style counters and histograms
- `/v1/model-validation/reviewed-datasets` serves reviewed dataset coverage for the current scope
- `examples/start-server.ts` bootstraps the standalone app from env
- `examples/embedded-runtime.ts` demonstrates in-process embedding without the HTTP shell

## Autonomous Delivery Loop

For continued autonomous build/validate work, the repo now includes a Ralph-style delivery loop at:

- `/Users/jacob/projects/conversation-intelligence-repo/.codex/ralph-runtime`

It is adapted for implementation work rather than read-only audits:

- it picks the next pending task from `worklist.json`
- runs `codex exec` in workspace-write mode
- runs the task's verification commands locally
- marks the task complete only after verification passes

## What Is Not Built Yet

The repo is still missing several production-critical layers:

- a fuller analyst workstation and pack-release controls
- automated pack rollout safeguards beyond the current release history and canary-evaluation hooks
- native OIDC/JWT validation inside the runtime
- larger eval packs and broader model validation coverage
- broader sentiment calibration before score-driven release gating
- richer long-context RLM routing and fallback policies
- support for non-support workflows

## PII Masking

PII masking is applied before prompts are built or jobs are persisted.

- built-in rules cover email, phone, SSN, and payment-card-like strings
- request payloads can add custom regex rules through `piiConfig.customRegexRules`
- service construction can add custom programmatic maskers for tenant-specific logic
- redaction counts and rule hits are attached to queued jobs and final analyses

## Local API Surface

The current local server is intentionally thin and SQLite-backed:

- `GET /healthz`
- `POST /v1/analyze`
- `POST /v1/jobs`
- `GET /v1/jobs`
- `GET /v1/jobs/:jobId`
- `POST /v1/runs`
- `GET /v1/runs`
- `GET /v1/runs/:runId`
- `GET /v1/runs/:runId/events`
- `GET /v1/runs/:runId/audit`
- `GET /v1/runs/:runId/stream`
- `POST /v1/runs/:runId/assignment`
- `POST /v1/runs/:runId/comments`
- `POST /v1/runs/:runId/review`
- `GET /v1/review-queue`
- `GET /v1/review-analytics`
- `GET /v1/schema/:version`
- `GET /v1/tenant-admin/config`
- `PUT /v1/tenant-admin/config`
- `GET /v1/model-validation/reports`
- `GET /v1/model-validation/alerts`
- `GET /v1/model-validation/recommend-thresholds`
- `POST /v1/model-validation/refresh-reviewed-exports`
- `POST /v1/model-validation/export-reviewed-runs`
- `POST /v1/model-validation/run`
- `GET /v1/tenant-packs/active`
- `POST /v1/tenant-packs/validate`
- `POST /v1/tenant-packs/preview`
- `POST /v1/tenant-packs/publish`
- `POST /v1/tenant-packs/approve`
- `POST /v1/tenant-packs/comment`
- `POST /v1/tenant-packs/evaluate-canary`
- `POST /v1/tenant-packs/auto-evaluate-canary`
- `POST /v1/tenant-packs/promote`
- `POST /v1/tenant-packs/rollback`
- `GET /app`
- `GET /metrics`

Jobs are persisted under `/Users/jacob/projects/conversation-intelligence-repo/data/conversation-intelligence.sqlite` when the example server runs.

Run visibility is backed by persisted `run_events` and `audit_events`, so a future internal or customer-facing workflow UI does not need Temporal or another heavy workflow system just to show progress.

The built-in `/app` console uses those same endpoints directly. It stays intentionally thin so self-hosted installs can ship one process without a separate frontend stack.

The console now also supports:

- viewing the active tenant pack and available versions
- validating, previewing, publishing, commenting on, evaluating, promoting, and rolling back pack JSON
- viewing derived sentiment scores on analyzed runs
- filtering review items, viewing SLA state, and running bulk analyst actions
- reading audit events for the selected run and release history for the selected pack

Analyst actions currently support:

- assign a review item to the current analyst
- add analyst comments without resolving the run
- verify a reviewed run
- mark a reviewed run uncertain
- keep a run in the review queue with an analyst note
- optionally attach an analyst sentiment score during review decisions for later validation exports

## Auth And Tenant Scoping

The HTTP server now supports three auth modes:

- `none` for local development
- `api_key` for lightweight service installs
- `trusted_proxy` for deployments behind an existing gateway

Tenant access is enforced from auth context at the API boundary, and audit events are emitted for key read/write paths.

OIDC guidance currently lives at the deployment edge rather than inside the runtime. Use gateway-terminated OIDC plus `trusted_proxy` mode. Details live in `/Users/jacob/projects/conversation-intelligence-repo/docs/AUTH.md`.

## Deployment

The repo now ships two concrete install paths:

- standalone app shell driven from env in `/Users/jacob/projects/conversation-intelligence-repo/examples/start-server.ts`
- embedded runtime driven directly in-process in `/Users/jacob/projects/conversation-intelligence-repo/examples/embedded-runtime.ts`

Deployment details live in `/Users/jacob/projects/conversation-intelligence-repo/docs/DEPLOYMENT.md`.

## Upstream RLM Decision

RLM remains a hard requirement, but the production boundary currently stays in this repo rather than patching `recursive-llm-ts` immediately.

The current upstream package is sufficient for:

- typed structured extraction
- local Go binary overrides
- prompt/context execution for long-context analysis

Immediate upstream changes are deferred until we hit a concrete need such as:

- prebuilt binary distribution instead of postinstall builds
- stronger request/trace correlation IDs
- tighter timeout and cancellation semantics
- richer structured-validation error surfaces for production triage

For now, standalone installs remain source-based rather than sealed packages because the local `recursive-llm-ts` dependency still relies on a Go build during install.

## Near-Term Build Order

1. Expand reviewed real-data coverage beyond the starter secure export flow.
2. Add schema-valid and latency regressions to Prometheus-facing metrics and external dashboards.
3. Expand sentiment validation well beyond the checked-in fixture sets before using score thresholds for hard release gates.
4. Add harder multi-tenant install examples and gateway reference configs.
5. Add richer notification channels beyond the current generic webhook delivery.
6. Decide whether production runtime concerns now justify upstream changes in `recursive-llm-ts`.
