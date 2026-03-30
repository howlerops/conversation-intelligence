# Engineering Decisions

## 2026-03-28

### Production boundary stays in this repo

`recursive-llm-ts` is required and is the canonical extraction engine for real runs, but the current production orchestration remains repo-local.

Reason:

- this repo needs transcript normalization, speaker gating, tenant mapping, persistence, and review logic that are product-specific rather than generic RLM concerns
- the local `recursive-llm-ts` API already exposes the minimum needed surface: typed structured extraction, Go binary override, and long-context execution

### No immediate upstream patch to `recursive-llm-ts`

We own `/Users/jacob/projects/recursive-llm-ts`, but no immediate patch is required to continue the production-first build here.

Potential upstream work later:

1. ship a cleaner binary distribution path so production installs do not rely on `postinstall` Go builds
2. expose stronger request IDs / trace IDs through the public API
3. tighten timeout, abort, and retry semantics for server workloads
4. improve schema-validation diagnostics for structured extraction failures

### Standalone packaging stays source-based for now

Do not force a sealed standalone package or container flow yet.

Reason:

- this repo still consumes `/Users/jacob/projects/recursive-llm-ts` as a local source dependency
- `recursive-llm-ts` still relies on a Go build during install
- freezing packaging now would add operational work before the upstream runtime surface is stable enough

Decision:

- keep standalone installs source-based for now
- keep the runtime bootstrap container-friendly, but do not treat container packaging as the primary delivery path yet
- revisit sealed packaging once `recursive-llm-ts` has a cleaner binary distribution story

### OIDC stays at the gateway for now

OIDC is important, but the low-overhead path is to terminate it outside this runtime and use `trusted_proxy` mode internally.

Reason:

- many target installs already have an ingress, API gateway, service mesh, or existing app shell
- duplicating token/session handling inside this runtime adds complexity without improving the workflow core
- the trusted-proxy contract is enough to preserve tenant scoping and audit attribution

### Sentiment score migration stays deferred until calibration

The runtime should keep the current `polarity` + `intensity` + `confidence` sentiment model as the canonical source of truth for now.

Reason:

- it is better for verifier logic and structured extraction debugging than a single coarse score
- a raw 1-5 scale is good for UI, but not sufficient as the only stored representation
- changing the canonical contract before analyst calibration would lock in a weak scoring model

Decision:

- keep the current canonical sentiment fields
- review a derived score model separately
- prefer a calibrated `score100` plus UI-facing `score5` over replacing the canonical fields outright

### Pack rollout stays lightweight but gains structured release history

Do not introduce a workflow engine for pack rollout yet.

Reason:

- release approvals, comments, and canary decisions can be modeled directly in the tenant-pack registry
- that keeps standalone and embedded installs aligned without adding Temporal, Redis, or another control-plane dependency
- persisted release history is enough to support both customer-facing and internal workflow visibility

Decision:

- keep pack rollout state in the file-backed tenant-pack registry for now
- record release history entries for publish, approve, comment, canary evaluation, activation, rejection, and rollback
- use a dedicated `evaluate-canary` hook so future automation can feed real metrics into the same release contract

### Review operations move into tenant admin config

Review SLA and assignment policy should not stay hard-coded in the service.

Reason:

- different tenants and queues will need different analyst response targets
- assignment behavior is operational policy, not model logic
- putting this in tenant admin config keeps standalone and embedded installs aligned

Decision:

- keep review SLA and assignment policy in a separate tenant admin config layer
- use that config to drive review analytics and optional auto-assignment behavior
- keep the tenant pack focused on analysis and release logic

### Real-data validation must use reviewed exports, not only fixtures

The checked-in fixtures are necessary but not sufficient.

Reason:

- they prove deterministic behavior, not production-scale drift
- model quality must be checked against analyst-reviewed real runs
- score drift and review drift are more important than fixture pass/fail once the service is live

Decision:

- keep fixture evals for regression safety
- add reviewed sentiment outcome validation that can read JSON or JSONL exports
- treat larger redacted reviewed datasets as the next gating layer before score-driven release controls

### Validation reporting stays in the runtime, not a separate workflow stack

Validation reports and alerts should be persisted directly by this runtime.

Reason:

- self-hosted installs need nightly validation without adding external schedulers or workflow systems
- reports and alerts are part of product quality state, not just operator logs
- the existing file-backed and Postgres-friendly runtime shape is enough for this layer today

Decision:

- export reviewed runs as redacted NDJSON from the runtime
- persist per-tenant and per-pack validation reports plus alerts
- expose reports and alerts over the same HTTP boundary as the rest of the service
