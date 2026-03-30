# Public Data Test Pipelines

Reviewed on 2026-03-28.

This document turns the original PRD and playbook into concrete offline test-pipeline rules for public and synthetic eval data.

## What The Original Spec Actually Says

From `/Users/jacob/projects/conversation-intelligence-repo/docs/Conversation_Intelligence_Playbook.docx` and `/Users/jacob/projects/conversation-intelligence-repo/docs/Conversation_Intelligence_PRD.docx`:

- shared models may use only public, licensed, or explicitly shared non-tenant data
- no single public corpus is enough; the system needs a mixture of workflow-rich dialogue, role-annotated dialogue, document-grounded dialogue, generic sentiment, and sarcasm data
- open-core packaging should stay on commercial-friendly data, while research-only corpora stay on a separate track
- synthetic data is explicitly required for support, sales, collections, and claims, especially for long-context, noise, promise-breaking, and internal-note contamination
- supported workflows extend beyond support into sales, collections, and claims, but everything still enters the runtime as text transcripts

That last point matters: calls, emails, and tickets should all be normalized into the same transcript contract, then evaluated through the same role-aware pipeline.

## Pipeline Mapping

The current repo now supports a spec-driven offline pipeline suite with these channel mappings:

- `CALL` -> public call/task dialogue corpora such as `TASKMASTER`; keep `CALLCENTEREN` on a separate research-only track
- `TICKET` -> workflow-rich public service dialogue such as `ABCD`, plus document-grounded support datasets like `DOC2DIAL` later
- `EMAIL` -> synthetic templates for now, because the original spec did not name a commercial-friendly public email-thread corpus

## Artifacts

The builder reads a suite manifest and writes per-pipeline artifacts:

- `pipeline.json` - normalized pipeline metadata and records
- `transcripts.jsonl` - ready-to-run transcript inputs for the runtime/eval harness
- `reviewed-sentiment.jsonl` - reviewed sentiment samples when analyst labels are present
- `summary.json` - suite-level counts by engagement type and use case

## Included Starter Suite

The checked-in starter manifest is:

- `/Users/jacob/projects/conversation-intelligence-repo/fixtures/public-data/pipeline-suite.json`
- `/Users/jacob/projects/conversation-intelligence-repo/fixtures/public-data/pipeline-suite.support-doc2dial.json`
- `/Users/jacob/projects/conversation-intelligence-repo/fixtures/public-data/pipeline-suite.support-callcenteren.research.json`

It covers:

- support calls from an open-core `TASKMASTER`-style slice
- support tickets from an open-core `ABCD`-style slice with short, medium, and long workflow examples
- support emails from a synthetic support-email slice so async support does not get represented only by collections traffic
- collections emails from a synthetic template slice with multiple negative and positive arrangement variants
- additional open-core policy-grounded support tickets from `DOC2DIAL` and `MULTIDOC2DIAL`
- a separate research-only `CALLCENTEREN` call slice

That gives us channel coverage for calls, tickets, and emails while staying faithful to the original data strategy.

## Build Command

```bash
npm run build:public-test-pipelines
```

Default output goes to:

- `/Users/jacob/projects/conversation-intelligence-repo/eval-data/public`

You can also point it at a custom manifest and output directory:

```bash
npm run build:public-test-pipelines -- fixtures/public-data/pipeline-suite.json /tmp/conversation-intelligence-public-evals
```

Compare those offline public slices against tenant shadow-validation exports:

```bash
npm run compare:public-shadow -- --public-path /tmp/conversation-intelligence-public-evals --shadow-path /absolute/path/reviewed-exports/tenant_acme/support.jsonl
```

The comparison output is engagement-type aware, so you can see where public `CALL`, `EMAIL`, or `TICKET` slices diverge from tenant `CALL`, `EMAIL`, or `TICKET` shadow data. Both inputs can be a single file or a directory tree of generated artifacts / reviewed-export snapshots.

The generated transcripts and reviewed samples now also carry queue and transcript-length metadata so the offline suite lines up with the batch validation reports.

For a larger mixed benchmark instead of the small starter suite, use:

```bash
npm run loop:e2e:public-scale:isolated -- /tmp/conversation-intelligence-public-scale-large --call-limit 12 --ticket-limit 12 --email-limit 12
```

That flow pulls larger real public `TASKMASTER` calls and `ABCD` tickets, generates a larger synthetic support-email slice, and combines those scale records with the reviewed starter manifests so one loop can report both operational scale behavior and accuracy on the reviewed holdouts.

## Next Expansion

The next datasets to add are:

1. additional synthetic templates for sales calls and claims tickets
2. merge-ready manifests that let us compare multiple public suites against one tenant shadow dataset in a single run
3. richer queue and transcript-length coverage for calls, not only email/ticket slices
4. span-level event expectations so the public-data suite can drive more than sentiment-only validation
