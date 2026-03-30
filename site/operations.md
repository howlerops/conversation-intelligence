# Operations

## Core operational loops

### Run processing

- submit analysis through POST /v1/jobs or POST /v1/runs
- track progress through /v1/runs, /v1/runs/:id, /v1/runs/:id/events, and /v1/runs/:id/stream
- resolve review items through /v1/runs/:id/review, /v1/runs/:id/assignment, and /v1/runs/:id/comments

### Reviewed exports

Reviewed exports are the bridge between live production traffic and model validation.

- refresh with POST /v1/model-validation/refresh-reviewed-exports
- inspect coverage with GET /v1/model-validation/reviewed-datasets
- export reviewed runs directly with POST /v1/model-validation/export-reviewed-runs

### Validation

- run model validation with POST /v1/model-validation/run
- inspect reports with GET /v1/model-validation/reports
- inspect alerts with GET /v1/model-validation/alerts
- recommend thresholds with GET /v1/model-validation/recommend-thresholds
- apply recommended thresholds with POST /v1/model-validation/apply-recommended-thresholds

### Pack release controls

- validate, preview, publish, approve, comment, evaluate-canary, auto-evaluate-canary, promote, and rollback packs through the /v1/tenant-packs/* endpoints
- inspect the active pack with GET /v1/tenant-packs/active

## Metrics and alerts

Enable Prometheus output with:

    CI_METRICS_ENABLED=true
    CI_METRICS_PATH=/metrics

Validation alerts support:

- generic webhook destinations
- Slack incoming webhooks

Recommended first alerts:

- schema-valid rate regression
- review-rate drift
- uncertain-rate drift
- sentiment drift
- latency regression
