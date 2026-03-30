# Self-Hosting

## Deployment shapes

### Minimal local install

- SQLite
- no auth or api_key auth
- single process with built-in UI and worker
- reviewed exports stored on local disk

### Standard production install

- Postgres
- trusted_proxy auth behind your gateway or OIDC terminator
- one or more worker processes
- reviewed exports written outside the app repo or container
- nightly validation and alert delivery enabled

### Embedded install

- integrate the runtime in an existing Node service
- keep your existing HTTP, auth, and observability stack
- optionally reuse the built-in console by serving it from a thin wrapper service

## Recommended production baseline

- CI_STORE=postgres
- CI_AUTH_MODE=trusted_proxy
- CI_REVIEWED_EXPORT_OUTPUT_DIR outside the application workspace
- CI_MODEL_VALIDATION_ENABLED=true
- CI_METRICS_ENABLED=true
- PII masking enabled with tenant-specific rules and any custom maskers required by your data model

## Auth modes

- none: local development only
- api_key: simple self-service installs
- trusted_proxy: preferred for production when an upstream gateway handles identity and tenancy

This service does not need to be your identity provider. Put it behind the gateway you already trust.

## Storage

### SQLite

Good for:

- local development
- demos
- low-volume internal installs

### Postgres

Good for:

- production queueing
- multi-worker setups
- retention, reporting, and larger validation workloads

The Postgres store uses row-lock claiming semantics instead of requiring a separate workflow engine.

## GitHub Pages docs deployment

This repo includes a Pages workflow at .github/workflows/docs-pages.yml.

After pushing to the default branch:

1. enable GitHub Pages for the repository
2. choose GitHub Actions as the build and deployment source
3. confirm the workflow succeeds

The site build is produced by npm run docs:build.
