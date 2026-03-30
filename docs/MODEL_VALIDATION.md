# Model Validation Plan

Reviewed on 2026-03-29.

This is the current path to validating the runtime on real data and at production scale.

## What Exists Now

- fixture evals for support extraction behavior
- reviewed sentiment calibration fixtures
- reviewed sentiment outcome validation against analyst labels
- engagement-specific sentiment scoring recommendation output from reviewed datasets
- tenant-pack canary automation driven by live run metrics
- reviewed-run NDJSON export from stored runs with redacted transcripts and analyst outcomes
- scheduled reviewed-export refresh into a secure external dataset path
- gzip-compressed snapshot output plus integrity manifests for refreshed reviewed exports
- reviewed dataset inventory so larger external reviewed trees can be inspected before running validation
- reviewed dataset readiness gating so nightly validation can fail closed when coverage or freshness drops
- per-tenant and per-pack validation reports with persisted alerts
- schema-valid rate and latency regression summaries in persisted reports
- threshold recommendation output for tenant-level tuning from live and reviewed data
- threshold application flow that can update tenant config and lock nightly shadow-validation cadence
- per-engagement threshold overrides so call, email, ticket, and unspecified traffic can alert independently once sample sizes are sufficient
- engagement-type drift breakdowns inside persisted validation reports and recommendations
- queue and transcript-length breakdowns inside persisted validation reports
- queue- and transcript-length-scoped validation alerts
- reviewed-export retention policy, snapshot pruning, and manifest-level classification metadata
- built-in validation dashboard in the self-hosted console
- Prometheus-facing validation gauges for global and scoped metrics
- webhook and Slack delivery for persisted validation alerts
- periodic model-validation worker support in standalone mode
- spec-driven public-data test pipelines for call, email, and ticket engagement types
- public-vs-shadow comparison tooling across engagement types

## Real-Data Validation Path

### Stage 1: Redacted analyst-reviewed holdout set

Use a redacted export of real runs with analyst outcomes attached.

Minimum fields per record:

- `runId`
- `tenantId`
- `useCase`
- model sentiment fields or stored `overallEndUserSentiment`
- analyst score or corrected label
- analyst review state
- whether a correction was applied

The runtime now supports loading this as JSON or JSONL through:

- `npm run eval:sentiment:reviewed`
- `tsx examples/run-reviewed-sentiment-validation.ts /path/to/reviewed-export.jsonl`
- `npm run recommend:sentiment-scoring -- /path/to/reviewed-export.jsonl`
- `npm run benchmark:e2e:isolated -- fixtures/benchmarks/e2e-smoke-suite.json /tmp/conversation-intelligence-e2e-smoke --concurrency 1 --max-records-per-source 1 --per-record-timeout-ms 90000 --child-timeout-ms 100000`
- `npm run loop:e2e:isolated -- fixtures/benchmarks/e2e-smoke-suite.json /tmp/conversation-intelligence-loop --reviewed-dataset /absolute/path/reviewed-exports --concurrency 1 --max-records-per-source 1 --per-record-timeout-ms 90000 --child-timeout-ms 100000`
- `npm run loop:e2e:isolated -- fixtures/benchmarks/e2e-large-suite.json /tmp/conversation-intelligence-loop-large --calibration-source benchmark --concurrency 1 --per-record-timeout-ms 90000 --child-timeout-ms 100000`
- `npm run loop:e2e:public-scale:isolated -- /tmp/conversation-intelligence-public-scale-large --call-limit 12 --ticket-limit 12 --email-limit 12 --concurrency 1 --per-record-timeout-ms 90000 --child-timeout-ms 100000`
- `npm run loop:e2e:reviewed -- /absolute/path/reviewed-exports/tenant_acme/support /absolute/path/tenant-pack.support.acme.json /tmp/conversation-intelligence-reviewed-loop --mode isolated --calibration-source reviewed --concurrency 1 --per-record-timeout-ms 90000 --child-timeout-ms 100000`
- `npm run export:reviewed-runs -- --tenant tenant_acme --use-case support --out /tmp/reviewed-support.jsonl`

It also supports reading a directory tree of reviewed JSON/JSONL snapshots and deduplicating repeated rows by run identity, so nightly validation can use a growing reviewed-export history instead of one flat file.

Compressed `.json.gz`, `.jsonl.gz`, and `.ndjson.gz` snapshots are also supported for larger reviewed datasets.

Reviewed sentiment validation and recommendation now accept either reviewed sentiment samples or raw reviewed-export trees with model labels plus analyst outcomes attached.

### Stage 2: Shadow validation before release gating

Before using any score operationally:

- run the candidate model on a frozen redacted holdout set
- compare output to analyst-reviewed outcomes
- measure score drift, review-rate drift, uncertain-rate drift, and schema-valid rate
- break results down by tenant, queue, language, and transcript length
- break results down by engagement type so call, email, and ticket behavior can drift independently
- only lock engagement-specific release gates after each engagement bucket meets its own run-count and reviewed-sample minimums

Nightly validation now also checks reviewed-dataset readiness before it runs:

- minimum reviewed-record count
- minimum analyst-sentiment count
- maximum dataset age
- optional coverage floors by engagement type, queue, and transcript-length bucket

If a scope misses those floors, validation skips with an explicit reason instead of silently generating a misleading report from under-sampled data.

### Stage 3: Controlled canary on production traffic

Use tenant-pack canaries plus live metrics to evaluate:

- failure rate
- review rate
- uncertain rate
- average sentiment score

This is not enough by itself. Canary metrics must be paired with analyst spot checks on sampled runs.

### Stage 4: Ongoing scale monitoring

For production scale, track these continuously:

- schema-valid rate
- extraction latency
- worker throughput
- review rate by tenant/use case
- uncertain rate by tenant/use case
- sentiment drift against reviewed samples
- speaker-resolution review triggers
- pack-version regressions after publish/canary/rollback

The runtime now persists report and alert summaries that can be queried over HTTP:

- `GET /v1/model-validation/reports`
- `GET /v1/model-validation/alerts`
- `GET /v1/model-validation/reviewed-datasets`
- `GET /v1/model-validation/recommend-thresholds`
- `POST /v1/model-validation/apply-recommended-thresholds`
- `POST /v1/model-validation/refresh-reviewed-exports`
- `POST /v1/model-validation/run`

For offline-vs-shadow comparison outside the HTTP surface:

- `npm run build:public-test-pipelines`
- `npm run compare:public-shadow -- --public-path eval-data/public --shadow-path /absolute/path/reviewed-exports/tenant_acme/support.jsonl`

For repeated end-to-end tuning loops:

- use `fixtures/benchmarks/e2e-smoke-suite.json` for the first Ollama smoke pass and `fixtures/benchmarks/e2e-large-suite.json` once the provider is stable enough for longer runs
- use `npm run loop:e2e:public-scale:isolated` when you need a larger mixed benchmark made of real public CALL/TICKET traffic, larger synthetic EMAIL traffic, and the reviewed holdouts in one run
- point `npm run benchmark:e2e:isolated` at local Ollama runs so each record is killable and per-record logs are preserved under `_children/`
- use `npm run benchmark:e2e` / `npm run loop:e2e` for stronger hosted models where the in-process path is stable enough
- use `npm run loop:e2e:isolated` to capture baseline vs calibrated benchmark summaries, gate failures, worst-record lists, and the selected calibration source in one report for local/provider-compatibility work
- use `npm run loop:e2e:trial-matrix:isolated` when you need best/median/worst evidence across repeated local-provider trials instead of a single loop sample
- use `npm run loop:e2e:reviewed` when you need the same loop shape against large reviewed-export trees instead of the public suite
- use `--calibration-source benchmark` when you need in-sample tuning from the benchmark records themselves instead of reviewed-export-derived offsets

As of March 29, 2026 local testing with local Ollama `qwen3.5`, the large public-engagement suite is currently stable and gate-passing:

- single calibrated large-suite run reached `averageDeltaScore100=2.36`
- single calibrated large-suite run reached `withinFivePointsRate=1.0`
- repeated 3-trial matrix reached `passRate=1.0` for both baseline and calibrated runs
- repeated 3-trial matrix was deterministic on score quality: calibrated `averageDeltaScore100=2.36`, `withinFivePointsRate=1.0`

The remaining benchmark-adjacent work is no longer public-suite drift closure. The next validation risk is real reviewed-export scale: larger tenant-reviewed datasets, nightly drift monitoring, and shadow-vs-production comparisons outside the synthetic/public suite.

## Recommended Validation Artifacts

Build and keep these datasets separate:

- `fixtures/` for deterministic unit/eval coverage
- `eval-data/reviewed/` for small checked-in redacted samples
- `eval-data/public/` for generated public/synthetic offline pipeline artifacts
- external secure storage for larger real-data exports

For the original public-data plan and the current call/email/ticket pipeline mapping, see `/Users/jacob/projects/conversation-intelligence-repo/docs/PUBLIC_DATA_TEST_PIPELINES.md`.

Do not check raw customer transcripts into this repo.

## External Observability

The runtime now emits enough Prometheus-facing metrics to build external dashboards for nightly validation and reviewed-export health:

- `conversation_intelligence_model_validation_*` for live/reviewed drift, schema-valid rate, latency, and scoped queue/length slices
- `conversation_intelligence_reviewed_dataset_*` for reviewed-dataset readiness, age, counts, and scoped coverage
- `conversation_intelligence_reviewed_exports_*` for export refreshes, bytes, coverage failures, retention policy, and snapshot pruning

Minimum production dashboard panels:

- reviewed dataset age, readiness, and record count by tenant/use-case
- schema-valid rate, failure rate, review rate, and uncertain rate by tenant/use-case
- reviewed drift (`average_delta_score100`, `within_five_points_rate`) by tenant/use-case
- queue and transcript-length scoped reviewed sample counts so under-sampled buckets are obvious

Alert on:

- reviewed dataset readiness dropping to `0`
- reviewed dataset age exceeding the configured freshness window
- schema-valid rate below threshold
- reviewed drift or bucket-match alerts on critical engagement slices

## Immediate Next Build For Scale Confidence

1. run the reviewed-export loop against a materially larger real tenant dataset across call, email, and ticket scopes
2. connect Slack/webhook alerts to richer on-call routing and escalation policy
3. add larger reviewed holdout sets and tenant-level drift breakdowns by transcript length and queue
4. feed large reviewed-export benchmark results back into pack/model release decisions
