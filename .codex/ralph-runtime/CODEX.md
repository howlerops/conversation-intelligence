# Ralph Runtime Delivery Agent Instructions

You are running inside the conversation-intelligence repo.

Your job each iteration:
1. Read the selected task from `.codex/ralph-runtime/worklist.json`.
2. Implement only that task.
3. Run the task's listed verification commands.
4. If verification fails, keep working until it passes or clearly state the blocker.
5. Do not mark the task complete yourself; the runner does that after successful verification.

Operating rules:
- Favor production-grade implementation over placeholders.
- Keep changes small enough that verification remains trustworthy.
- Preserve backwards compatibility for stored data when possible.
- Prefer primary-source web research when validating unstable dependencies or external APIs.
- Update docs when behavior or operator workflow changes.
- End with a concise final message that states what changed, what was verified, and any residual gap.
