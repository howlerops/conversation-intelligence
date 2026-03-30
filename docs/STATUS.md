# Docs Status Review

Reviewed on 2026-03-29 against the current repository state.

## What The Repo Now Covers

The implementation already matches these parts of the design pack:

- text-transcript scope only
- English-first support workflow
- tenant-pack runtime configuration instead of tenant training
- canonical transcript, tenant-pack, analysis, run-event, and audit-event contracts
- transcript normalization
- speaker-role resolution with END_USER gating
- canonical extraction plus verifier-driven review routing
- asynchronous job flow plus synchronous `analyzeNow` path
- analyst review queue
- analyst assignment, comments, review history, SLA-aware review analytics, and audit visualization
- persisted workflow visibility with run events and audit events
- self-hosted run console and Prometheus-style metrics export
- schema registry endpoint
- tenant-pack validate, preview, publish, approve, comment, evaluate-canary, promote, and rollback APIs
- tenant admin config for review SLA, assignment policy, and canary automation
- lightweight approval, release history, automated canary evaluation, and rollback controls for tenant-pack releases
- derived sentiment scoring with a tolerance-based reviewed calibration set
- reviewed sentiment outcome validation against analyst labels
- engagement-specific sentiment calibration recommendations plus tenant-scoped runtime offsets
- reviewed-run export from persisted runs with redacted transcript output
- scheduled reviewed-export refresh into a secure external dataset path
- gzip-compressed reviewed-export snapshots plus manifest files with hashes and coverage counts
- reviewed-export manifest classification, transcript-inclusion flags, coverage failures, and automatic snapshot pruning
- reviewed dataset inventory for larger reviewed-export trees
- reviewed dataset readiness gating for nightly validation based on count, freshness, and scoped coverage floors
- persisted per-tenant and per-pack validation reports plus alert generation
- schema-valid rate and latency regression summaries in validation reports
- threshold recommendation tooling for tenant-level validation tuning
- threshold-application flow for tenant configs plus nightly shadow-validation scheduling
- per-engagement validation threshold overrides and scoped alerting
- spec-driven public/synthetic offline test pipelines for calls, tickets, and emails
- engagement-type drift breakdowns in validation reports and public-vs-shadow comparison tooling
- queue and transcript-length breakdowns in persisted validation reports
- queue- and transcript-length-scoped validation alerts in reports and UI
- built-in validation dashboards in the run console plus webhook/Slack alert delivery
- Prometheus-facing validation gauges for global and scoped metrics
- end-to-end benchmark and improvement-loop scripts for larger engagement datasets
- isolated benchmark and improvement-loop scripts for local Ollama runs with per-record child logs
- a generated large-scale mixed public benchmark path that combines real public CALL/TICKET traffic, larger synthetic EMAIL traffic, and the reviewed holdouts in one isolated loop
- repeated trial-matrix loop artifacts for best/median/worst local-provider validation
- benchmark-derived sentiment calibration for the isolated large-suite loop, including worst-record reporting and calibration-source tracking
- reviewed-export benchmark-loop script for secure real-data trees, with dataset summary output and isolated/in-process modes
- Prometheus-facing reviewed-dataset readiness gauges for external dashboards
- local Ollama `qwen3.5` large-suite quality-gate closure for the current public engagement suite, with stable repeated-trial results
- standalone and embedded install paths
- a Ralph-style autonomous delivery loop under `.codex/ralph-runtime`

## What Is Only Partially Complete

- deep adjudication exists through the RLM-backed engine, but not yet as the fuller isolated worker/container topology described in the architecture doc
- local Ollama support now has an `ollama_json_compat` extraction mode that keeps smoke benchmarks running, but it currently extracts summary + overall sentiment + review only and leaves events/aspects/key moments empty for that provider path
- observability now includes reviewed-dataset and reviewed-export health gauges in addition to the earlier validation metrics, but external dashboards and trace grading are still operator work rather than built-in product surfaces
- auth is solid for `api_key` and `trusted_proxy`, with OIDC intentionally terminated at the gateway rather than inside this runtime
- review workflow exists, including analyst actions, comments, assignment, history, analytics, filtering, bulk actions, SLA visibility, and audit reads, but not yet as a full analyst workstation
- async processing now includes automated canary evaluation and periodic validation runs, but not yet with richer orchestration policies, dashboards, or release approvals beyond the current registry model
- sentiment extraction now passes the current public large-suite quality gates locally, but it is not yet proven on larger real reviewed-export datasets and should not be treated as fully validated for score-driven release decisions

## What Is Still Missing Relative To The Design Docs

- sales, collections, claims, and broader multi-use-case packs
- scene segmentation and separate fast candidate models before deep adjudication
- public-data training pipeline, open-core dataset packaging, and release-line model management
- broader public-data coverage beyond the current call/ticket/email starter pipeline suite
- tenant self-service pack management UI
- regression dashboards and stronger formal release controls
- sentiment score calibration on a larger real reviewed dataset
- full-fidelity local-model extraction for Ollama-compatible reasoning models without the current compatibility fallback
- pager/on-call escalation beyond the current webhook/Slack delivery
- tenant-scale reviewed-export benchmark evidence across materially larger real call/email/ticket datasets

## Docs That Remain Accurate As Product Direction

- `/Users/jacob/projects/conversation-intelligence-repo/docs/Conversation_Intelligence_PRD.docx`
- `/Users/jacob/projects/conversation-intelligence-repo/docs/Conversation_Intelligence_Architecture.docx`
- `/Users/jacob/projects/conversation-intelligence-repo/docs/Conversation_Intelligence_Playbook.docx`

These remain good target-state documents, but they are ahead of the codebase.

## Docs That Reflect Current Runtime Reality

- `/Users/jacob/projects/conversation-intelligence-repo/docs/ENGINEERING_DECISIONS.md`
- `/Users/jacob/projects/conversation-intelligence-repo/docs/DEPLOYMENT.md`
- `/Users/jacob/projects/conversation-intelligence-repo/docs/AUTH.md`
- `/Users/jacob/projects/conversation-intelligence-repo/docs/IMPLEMENTATION_ARCHITECTURE.md`
- `/Users/jacob/projects/conversation-intelligence-repo/docs/SENTIMENT_SCORING.md`
- `/Users/jacob/projects/conversation-intelligence-repo/docs/MODEL_VALIDATION.md`
- `/Users/jacob/projects/conversation-intelligence-repo/docs/PUBLIC_DATA_TEST_PIPELINES.md`

## Practical Conclusion

The docs folder is now split into two categories:

- target-state design docs in `.docx`
- current-state implementation docs in `.md`

That split is now bridged by `/Users/jacob/projects/conversation-intelligence-repo/docs/IMPLEMENTATION_ARCHITECTURE.md`, which should be treated as the current source of truth for what is real today.
