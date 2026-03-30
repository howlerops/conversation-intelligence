#!/usr/bin/env bash
set -euo pipefail

ITERATIONS="${1:-1}"
SEARCH=1
if [[ "${2:-}" == "--no-search" ]]; then
  SEARCH=0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKLIST="$SCRIPT_DIR/worklist.json"
INSTRUCTIONS="$SCRIPT_DIR/CODEX.md"
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI is required on PATH" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required on PATH" >&2
  exit 1
fi

pick_task() {
  jq -c '[.tasks[] | select(.status != "done")][0]' "$WORKLIST"
}

update_task_done() {
  local task_id="$1"
  local now="$2"
  local tmp
  tmp="$(mktemp)"
  jq --arg id "$task_id" --arg now "$now" '
    .tasks |= map(if .id == $id then .status = "done" | .completedAt = $now else . end)
  ' "$WORKLIST" > "$tmp"
  mv "$tmp" "$WORKLIST"
}

for ((i = 0; i < ITERATIONS; i++)); do
  task_json="$(pick_task)"
  if [[ -z "$task_json" || "$task_json" == "null" ]]; then
    echo "No pending tasks remain."
    exit 0
  fi

  task_id="$(jq -r '.id' <<<"$task_json")"
  task_title="$(jq -r '.title' <<<"$task_json")"
  prompt_file="$(mktemp)"
  {
    cat "$INSTRUCTIONS"
    echo
    echo "Repository root: $REPO_ROOT"
    echo "Task ID: $task_id"
    echo "Task Title: $task_title"
    echo "Task Summary: $(jq -r '.summary // ""' <<<"$task_json")"
    echo
    echo "Acceptance Criteria:"
    jq -r '.acceptance[]? | "- " + .' <<<"$task_json"
    echo
    echo "Verification Commands:"
    jq -r '.verifyCommands[]? | "- `" + . + "`"' <<<"$task_json"
  } > "$prompt_file"

  log_path="$LOG_DIR/${task_id}.md"
  cmd=(codex exec -s workspace-write --output-last-message)
  if (( SEARCH )); then
    cmd+=(--search)
  fi

  (
    cd "$REPO_ROOT"
    "${cmd[@]}" < "$prompt_file"
  ) | tee "$log_path"

  mapfile -t verify_commands < <(jq -r '.verifyCommands[]?' <<<"$task_json")
  for verify_command in "${verify_commands[@]}"; do
    (
      cd "$REPO_ROOT"
      bash -lc "$verify_command"
    )
  done

  update_task_done "$task_id" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  rm -f "$prompt_file"
done
