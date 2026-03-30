# Getting Started

## Prerequisites

- Node.js 20+
- Go toolchain installed locally because recursive-llm-ts builds a Go binary during install
- either an OpenAI-compatible endpoint or local Ollama

The repo currently depends on the sibling checkout at /Users/jacob/projects/recursive-llm-ts.

## Install

    npm install

## Choose a model provider

### Ollama

    export CI_PROVIDER=ollama
    export OLLAMA_BASE_URL=http://localhost:11434
    export OLLAMA_MODEL=qwen3.5

### OpenAI-compatible

    export CI_PROVIDER=openai-compatible
    export OPENAI_API_KEY=...
    export OPENAI_API_BASE=...
    export CI_RLM_MODEL=gpt-4o-mini

## Core development loop

    npm run typecheck
    npm test
    npm run eval:fixtures
    npm run eval:sentiment
    npm run eval:sentiment:reviewed
    npm run build

## Start the service

    npm run serve:standalone

Default local endpoints:

- app UI: `http://localhost:8787/app`
- API: `http://localhost:8787`
- metrics: `http://localhost:8787/metrics`

## Analyze a fixture

    npm run analyze:fixture

## Run the built-in public large-scale benchmark

    CI_PROVIDER=ollama     OLLAMA_BASE_URL=http://localhost:11434     OLLAMA_MODEL=qwen3.5     CI_RLM_MAX_DEPTH=1     CI_RLM_MAX_ITERATIONS=1     CI_RLM_TIMEOUT_SECONDS=45     npm run loop:e2e:public-scale:isolated --       /tmp/conversation-intelligence-public-scale-large       --call-limit 12       --ticket-limit 12       --email-limit 12       --concurrency 1       --per-record-timeout-ms 90000       --child-timeout-ms 100000
