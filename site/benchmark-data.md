# Benchmark Data

## Current benchmark data sources

### Reviewed public suites

The repo includes labeled public benchmark manifests for support-style engagements:

- fixtures/public-data/pipeline-suite.json
- fixtures/public-data/pipeline-suite.support-doc2dial.json
- fixtures/public-data/pipeline-suite.support-callcenteren.research.json

These are the best current substitute for a reviewed-export tree when you need deterministic benchmark labels without tenant data.

### Large-scale ops suites

The large mixed public benchmark pulls from:

- Taskmaster for call-shaped public traffic
- ABCD for ticket-shaped public traffic
- deterministic synthetic support email templates for higher-volume email traffic

The scale ops slice is intentionally mostly unlabeled. It is for throughput, stability, failure-rate, and latency testing.

## Build a reviewed-style benchmark dataset

Use this when you want a reviewed-export tree generated from the public labeled suites:

    npm run build:reviewed-benchmark -- /tmp/conversation-intelligence-reviewed-benchmark

Artifacts written under the output directory:

- summary.json
- annotation-candidates.jsonl
- `tenant_id/use_case/latest.jsonl`
- `tenant_id/use_case/snapshots/timestamp.jsonl.gz`
- `tenant_id/use_case/benchmark-dataset.manifest.json`

## Expand the benchmark with new annotation candidates

If you generate or curate additional unlabeled public suites, include them as annotation sources:

    npm run build:reviewed-benchmark --       /tmp/conversation-intelligence-reviewed-benchmark       --annotation-manifest /tmp/conversation-intelligence-public-scale-large/data/public-scale-pipeline-suite.json

That preserves all reviewed public records and emits unlabeled candidate rows into annotation-candidates.jsonl.

Each candidate includes:

- transcript and engagement metadata
- queue and transcript-length bucket
- canonical event labels and tags
- an empty annotation template for sentiment and review state

## Generate draft annotations for the backlog

Use the current runtime to pre-label the backlog before human review:

    CI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3.5 CI_RLM_MAX_DEPTH=1 CI_RLM_MAX_ITERATIONS=1 CI_RLM_TIMEOUT_SECONDS=45 npm run annotate:reviewed-benchmark --       /tmp/conversation-intelligence-reviewed-benchmark-with-annotations/annotation-candidates.jsonl       /tmp/conversation-intelligence-reviewed-benchmark-drafts       --tenant-pack fixtures/tenant-pack.support.acme.json       --trials 3       --concurrency 1       --per-record-timeout-ms 90000

Artifacts written under the output directory:

- draft-annotation-summary.json
- draft-annotation-report.json
- draft-annotations.jsonl
- draft-annotation-review.md

These labels are system-generated drafts. They help close the operational gap while a human reviewer works the backlog, but they are not benchmark truth by themselves.

## Why this matters

The goal is to create benchmark data in the same shape as real reviewed exports so the exact same validation and benchmark loops can run before tenant data is available.

That is not equivalent to true tenant-reviewed data, but it closes the infrastructure gap and gives you a disciplined path to grow a benchmark corpus.
