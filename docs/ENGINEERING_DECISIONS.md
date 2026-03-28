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
