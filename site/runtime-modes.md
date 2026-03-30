# Runtime Modes

## Standalone app

Use this when you want a complete service with:

- HTTP API
- polling worker
- built-in run console
- metrics endpoint
- reviewed-export refresh and model-validation workers

Start it with:

    npm run serve:standalone

Typical standalone stack:

- CI_STORE=sqlite for local or small-team installs
- CI_STORE=postgres and DATABASE_URL=... for production
- CI_AUTH_MODE=api_key or trusted_proxy

## Embedded runtime

Use this when you want to call the runtime inside an existing app and avoid a separate service boundary.

Reference entrypoint:

    npm run embedded:fixture

Embedded mode is appropriate when:

- you already have auth, tenancy, and request routing elsewhere
- you want in-process orchestration
- you only need the runtime and worker, not the built-in UI shell

## Benchmark isolation modes

The validation harness supports two execution modes:

- in_process: best for strong hosted models and faster local feedback
- isolated: best for local Ollama or unstable providers because each record can be timed out and killed independently

Use isolated mode when you care about repeatable large-suite results on local models.
