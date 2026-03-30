# Ralph Runtime Loop

This is a repo-local adaptation of the Ralph loop concept for delivery work instead of read-only audits.

What it does:
- reads `.codex/ralph-runtime/worklist.json`
- picks the next task where `status != "done"`
- builds a Codex prompt from `.codex/ralph-runtime/CODEX.md` plus the task details
- runs `codex exec` in workspace-write mode
- runs the task's verification commands locally
- marks the task complete only if Codex exits successfully and all verification commands pass
- writes the final Codex message into `.codex/ralph-runtime/logs/<task-id>.md`

Usage:

```bash
cd /Users/jacob/projects/conversation-intelligence-repo/.codex/ralph-runtime
./ralph-runtime.sh 5
```

Disable web research:

```bash
./ralph-runtime.sh 5 --no-search
```

Notes:
- This loop is for iterative build/validate work, not read-only auditing.
- Keep `worklist.json` small and explicit; each task should have concrete acceptance criteria and verify commands.
- The runner assumes `codex` and `jq` are installed.
- For model-quality work, prefer verify commands that write benchmark artifacts via `npm run benchmark:e2e:isolated` or `npm run loop:e2e:isolated -- --calibration-source benchmark` for local Ollama runs, and `npm run benchmark:e2e` / `npm run loop:e2e` for stable hosted providers.
