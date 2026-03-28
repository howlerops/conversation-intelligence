# Conversation Intelligence

Production-first scaffold for a speaker-aware conversation intelligence system built around `recursive-llm-ts`.

This repo started as a docs handoff. It now includes the first executable foundation for the v0 production slice:

- canonical transcript, tenant-pack, and analysis contracts
- transcript normalization
- deterministic speaker resolution and role gating
- tenant event mapping
- review-oriented verification
- SQLite-backed job persistence
- a polling worker for queued analysis
- configurable PII masking with request-level regex rules and service-level custom maskers
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
OPENAI_API_KEY=... npm run serve:dev
```

Run the example fixture through RLM:

```bash
OPENAI_API_KEY=... npm run analyze:fixture
```

Optional environment variables:

- `CI_RLM_MODEL` - overrides the default model (`gpt-4o-mini`)
- `OPENAI_API_BASE` - custom OpenAI-compatible endpoint
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

## What Is Not Built Yet

The repo is still missing several production-critical layers:

- Postgres-backed persistence and a distributed queue
- authn/authz and tenancy isolation at the API boundary
- analyst review tooling beyond the queue snapshot endpoint
- eval harness scale beyond starter fixtures
- metrics and tracing
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
- `GET /v1/review-queue`

Jobs are persisted under `/Users/jacob/projects/conversation-intelligence-repo/data/conversation-intelligence.sqlite` when the example server runs.

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

## Near-Term Build Order

1. Add Postgres storage and a multi-process worker queue behind the existing `JobStore` boundary.
2. Add request authentication, tenant scoping, and audit trails around the HTTP API.
3. Expand eval coverage with larger fixture packs and threshold reporting.
4. Add metrics, traces, and failure triage around the RLM execution path.
5. Decide whether production runtime concerns now justify upstream changes in `recursive-llm-ts`.
