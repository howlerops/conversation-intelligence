# API and Runtime

## Core HTTP routes

### Health and metadata

- GET /healthz
- GET /v1/schema/:name
- GET /v1/tenant-packs/active
- GET /v1/tenant-admin/config
- PUT /v1/tenant-admin/config

### Analysis and run tracking

- POST /v1/analyze
- POST /v1/jobs
- POST /v1/runs
- GET /v1/jobs
- GET /v1/jobs/:id
- GET /v1/runs
- GET /v1/runs/:id
- GET /v1/runs/:id/events
- GET /v1/runs/:id/stream
- GET /v1/runs/:id/audit

### Review workflow

- GET /v1/review-queue
- GET /v1/review-analytics
- POST /v1/runs/:id/review
- POST /v1/runs/:id/assignment
- POST /v1/runs/:id/comments

### Validation and reviewed exports

- GET /v1/model-validation/reports
- GET /v1/model-validation/reviewed-datasets
- GET /v1/model-validation/recommend-thresholds
- GET /v1/model-validation/alerts
- POST /v1/model-validation/run
- POST /v1/model-validation/export-reviewed-runs
- POST /v1/model-validation/refresh-reviewed-exports
- POST /v1/model-validation/apply-recommended-thresholds

### Pack lifecycle

- POST /v1/tenant-packs/validate
- POST /v1/tenant-packs/preview
- POST /v1/tenant-packs/publish
- POST /v1/tenant-packs/approve
- POST /v1/tenant-packs/comment
- POST /v1/tenant-packs/evaluate-canary
- POST /v1/tenant-packs/auto-evaluate-canary
- POST /v1/tenant-packs/promote
- POST /v1/tenant-packs/rollback

## Runtime architecture

The runtime is intentionally split into four concerns:

- core contracts and analysis pipeline
- storage adapters
- service and worker runtime
- optional app shell and UI

This keeps the same run model usable in embedded installs, standalone service installs, and future managed deployments.

## Workflow visibility

A workflow engine is not required here. Workflow visibility comes from persisted run state, run events, audit events, and SSE updates.

That is sufficient for:

- end-user and analyst run visibility
- review queue operation
- validation and canary reporting
- future integration with a heavier orchestrator if scale later requires it
