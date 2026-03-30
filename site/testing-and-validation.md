# Testing and Validation

## Local test layers

### Unit and integration

    npm test
    npm run typecheck
    npm run build

### Fixture evals

    npm run eval:fixtures
    npm run eval:sentiment
    npm run eval:sentiment:reviewed

These cover:

- promise-breaking and repeat-contact behavior
- sarcasm and review routing
- admin-note contamination
- reviewed sentiment comparison against analyst labels

## Benchmark loops

### Public reviewed benchmark

This exercises the same reviewed_run_exports benchmark path used for real reviewed-export trees, but builds the dataset from the labeled public suites first.

    CI_PROVIDER=ollama     OLLAMA_BASE_URL=http://localhost:11434     OLLAMA_MODEL=qwen3.5     CI_RLM_MAX_DEPTH=1     CI_RLM_MAX_ITERATIONS=1     CI_RLM_TIMEOUT_SECONDS=45     npm run loop:e2e:public-reviewed --       /tmp/conversation-intelligence-public-reviewed       --mode isolated       --concurrency 1       --per-record-timeout-ms 90000       --child-timeout-ms 100000

### Large mixed public benchmark

Use this for end-to-end throughput and stability across engagement types:

    CI_PROVIDER=ollama     OLLAMA_BASE_URL=http://localhost:11434     OLLAMA_MODEL=qwen3.5     CI_RLM_MAX_DEPTH=1     CI_RLM_MAX_ITERATIONS=1     CI_RLM_TIMEOUT_SECONDS=45     npm run loop:e2e:public-scale:isolated --       /tmp/conversation-intelligence-public-scale-large       --call-limit 12       --ticket-limit 12       --email-limit 12       --concurrency 1       --per-record-timeout-ms 90000       --child-timeout-ms 100000

### Real reviewed-export benchmark

Use this when you have a secure reviewed-export tree mounted locally or in your runner:

    CI_PROVIDER=ollama     OLLAMA_BASE_URL=http://localhost:11434     OLLAMA_MODEL=qwen3.5     CI_RLM_MAX_DEPTH=1     CI_RLM_MAX_ITERATIONS=1     CI_RLM_TIMEOUT_SECONDS=45     npm run loop:e2e:reviewed --       /absolute/path/reviewed-exports/tenant_acme/support       /absolute/path/tenant-pack.support.acme.json       /tmp/conversation-intelligence-reviewed-loop       --mode isolated       --calibration-source reviewed       --concurrency 1       --per-record-timeout-ms 90000       --child-timeout-ms 100000

## What counts as proof

Public benchmarks prove:

- end-to-end runtime behavior
- provider stability under load
- cross-engagement support coverage
- regression visibility across queues and transcript lengths

Real reviewed-export benchmarks prove:

- tenant-representative drift
- operational threshold fitness
- review-rate and uncertain-rate behavior on true production distributions
- release safety for a specific tenant and pack version

Do not use public benchmark results alone to set final tenant release gates.
