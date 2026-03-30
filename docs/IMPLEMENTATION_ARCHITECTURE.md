# Implementation Architecture

Reviewed on 2026-03-28.

This document bridges the gap between the target-state `.docx` design pack and the runtime that actually exists in this repository today.

## Current Runtime Boundary

The current implementation is a single runtime with optional shells around it:

- headless processing runtime
- optional HTTP API
- optional built-in workflow UI at `/app`
- optional Prometheus-style metrics at `/metrics`

It is intentionally designed to run in either:

- embedded mode inside an existing Node service
- standalone mode as its own app with API, worker, storage, and UI

## Current Module Map

### 1. API, auth, and UI shell

- `src/api/http-server.ts`
- `src/auth/http-auth.ts`
- `src/admin/file-tenant-admin-config-registry.ts`
- `src/ui/run-console.ts`

Responsibilities:

- auth and tenant scoping
- sync and async run endpoints
- review actions and review comments
- review filtering and bulk review actions in the built-in console
- tenant admin config reads and updates
- run-event and audit-event reads
- tenant-pack admin endpoints including release comments, manual canary evaluation, and automated canary evaluation
- built-in workflow console

### 2. Runtime orchestration

- `src/service/conversation-intelligence-service.ts`
- `src/service/analysis-worker.ts`
- `src/service/canary-automation-service.ts`
- `src/service/canary-automation-worker.ts`
- `src/service/model-validation-service.ts`
- `src/service/model-validation-worker.ts`

Responsibilities:

- queue submission
- claimed-job execution
- analyst assignment, comments, review decisions, and SLA analytics from tenant admin config
- run-event emission
- audit-event persistence
- canary metric computation from live run history
- reviewed-run export
- periodic validation report generation and alert evaluation

### 3. Analysis pipeline

- `src/pipeline/analyze-conversation.ts`
- `src/pipeline/normalize-transcript.ts`
- `src/pipeline/resolve-speakers.ts`
- `src/pipeline/map-tenant-events.ts`
- `src/pipeline/verify-analysis.ts`
- `src/sentiment/scoring.ts`

Responsibilities:

- transcript normalization
- role resolution
- prompt construction and engine invocation
- verifier-driven review routing
- derived sentiment scoring

### 4. Engine adapter

- `src/rlm/engine.ts`
- `src/rlm/provider-profile.ts`
- local dependency: `/Users/jacob/projects/recursive-llm-ts`

Responsibilities:

- structured extraction through RLM
- OpenAI-compatible and Ollama provider wiring
- model selection through env-driven profiles

### 5. Storage and runtime state

- `src/store/sqlite-job-store.ts`
- `src/store/postgres-job-store.ts`
- `src/admin/file-tenant-admin-config-registry.ts`
- `src/packs/file-tenant-pack-registry.ts`
- `src/validation/file-model-validation-report-store.ts`

Responsibilities:

- run persistence
- run-event persistence
- audit-event persistence
- review queue reads
- tenant admin configuration
- tenant-pack version storage, release records, and activation state
- persisted model-validation reports and alerts

## Request Flows

### Synchronous analysis

1. request enters `POST /v1/analyze`
2. auth and tenant scope are enforced
3. request is PII-masked
4. transcript is normalized and speakers are resolved
5. RLM performs canonical extraction
6. verifier applies release gates
7. derived sentiment score is attached
8. final analysis is returned

### Asynchronous analysis

1. request enters `POST /v1/runs`
2. masked request is persisted as a queued run
3. worker claims the run
4. analysis pipeline executes
5. run events are appended through each lifecycle stage
6. completed result is stored
7. review queue and run console update from persisted state

### Model validation flow

1. reviewed runs are exported as redacted NDJSON from persisted run state
2. reviewed exports are stored in a local or external secure dataset location
3. the validation worker reads reviewed exports plus live run history
4. per-tenant and per-pack reports are generated with drift and regression summaries
5. alerts are persisted for canary rejection, failure/review/uncertain spikes, and sentiment drift

### Review flow

1. verifier flags a run as `NEEDS_REVIEW`
2. analysts can assign the run to themselves
3. analysts can add comments without resolving the run
4. analysts can verify, mark uncertain, or keep in review
5. review history, comments, analytics, SLA state, and audit events are persisted

## Current Data Artifacts

Stable contracts exist for:

- transcript input
- tenant packs
- conversation analysis
- runs
- run events
- audit events
- review requests
- reviewed-run export records
- model-validation reports
- model-validation alerts

The schema registry exposes the current JSON Schema view at `GET /v1/schema/v1`.

## Tenant-Pack Management

The current runtime already supports:

- validate
- preview
- publish
- approve
- comment
- evaluate canary
- promote
- rollback
- active-pack inspection

What is still missing is a fuller operational layer around those APIs:

- rollback policies
- stronger release history UX and release diffing
- deeper release dashboards on top of the persisted validation/report model

## Sentiment Model

The canonical extraction still stores:

- polarity
- intensity
- confidence

The runtime now adds a derived score layer:

- `score100` for analytics
- `score5` for UI

Those derived scores are provisional and calibrated only against the current reviewed fixture set. They should not yet be treated as release-gating metrics without a larger reviewed dataset.

## What This Runtime Deliberately Does Not Use

The current runtime does not require:

- Temporal
- Redis
- Kafka
- a separate workflow service

That is intentional. Persisted run events plus SSE are enough for the current workflow-visibility requirement without adding extra infrastructure.

## Target-State Gaps

The `.docx` design pack still describes a broader target state than the codebase implements today. The main gaps are:

- broader non-support use cases
- richer model-routing topology before deep adjudication
- richer pack release controls and dashboards
- larger-scale analytics and alerting
- public/open-core dataset and model-release workflows

## Practical Reading Order

For the current runtime, read these in order:

1. `README.md`
2. `docs/IMPLEMENTATION_ARCHITECTURE.md`
3. `docs/DEPLOYMENT.md`
4. `docs/AUTH.md`
5. `docs/MODEL_VALIDATION.md`
6. `docs/ENGINEERING_DECISIONS.md`
7. the target-state `.docx` files
