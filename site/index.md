---
layout: home
hero:
  name: Conversation Intelligence
  text: Speaker-aware analysis for calls, email, tickets, and review workflows
  tagline: Production-first runtime, self-hostable service, and benchmark/validation stack built around recursive-llm-ts.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: Validation Guide
      link: /testing-and-validation
features:
  - title: Production-first runtime
    details: Queue-backed service, SQLite or Postgres storage, auth modes, PII masking, analyst review, canary release controls, and built-in workflow UI.
  - title: Self-hostable or embedded
    details: Run as a standalone app with HTTP, UI, and metrics, or embed the runtime and worker directly into an existing Node stack.
  - title: Measurable quality
    details: Public benchmark pipelines, reviewed-export validation, sentiment calibration, drift reporting, alerts, and large-scale end-to-end benchmark loops.
---

## What this is

Conversation Intelligence extracts canonical support analysis from raw engagement transcripts while preserving one non-negotiable rule: end-user sentiment and key moments are scoped to the end user, not to agent, admin, or system turns.

The current implementation supports:

- support use cases first
- text transcripts for CALL, EMAIL, and TICKET
- RLM as the required extraction engine for real runs
- post-engagement async analysis with review routing
- standalone or embedded deployment modes

## What is already implemented

- canonical contracts for transcripts, analysis, runs, review, packs, admin config, and model validation
- SQLite and Postgres job stores
- built-in run console, review actions, audit trail, SSE run updates, metrics endpoint
- reviewed-export generation, nightly validation, canary automation, and public benchmark loops
- large mixed public benchmark coverage across CALL, EMAIL, and TICKET

## Where to go next

- [Getting Started](/getting-started) for local usage
- [Self-Hosting](/self-hosting) for deployment options
- [Testing and Validation](/testing-and-validation) for quality gates and benchmark loops
- [Benchmark Data](/benchmark-data) for building reviewed-style benchmark datasets and annotation batches
- [API and Runtime](/api-and-runtime) for endpoints and runtime architecture
