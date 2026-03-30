Conversation Intelligence Design Pack
Generated: March 27, 2026

Included documents:
- Conversation_Intelligence_PRD.docx
- Conversation_Intelligence_Architecture.docx
- Conversation_Intelligence_Playbook.docx
- ENGINEERING_DECISIONS.md
- DEPLOYMENT.md
- AUTH.md
- IMPLEMENTATION_ARCHITECTURE.md
- MODEL_VALIDATION.md
- STATUS.md
- SENTIMENT_SCORING.md
- PUBLIC_DATA_TEST_PIPELINES.md
- ../site/ (GitHub Pages documentation site source)

This pack is designed for:
- text transcripts only
- multi-tenant support
- no tenant-specific training
- speaker-aware scoring where end-user sentiment and key moments exclude admin/system/agent turns by default

Note:
- the `.docx` files are target-state design docs
- the `.md` files reflect the current implementation status and operating decisions
- `IMPLEMENTATION_ARCHITECTURE.md` is the bridge between those two layers
- `MODEL_VALIDATION.md` is the current source of truth for real-data and scale validation work
- `SENTIMENT_SCORING.md` tracks the pending review of user-facing sentiment score design
- `../site/` is the publishable operator and self-serve docs surface
