#!/usr/bin/env bash
set -euo pipefail

OWNER="${1:-}"
REPO_NAME="${2:-conversation-intelligence-docs}"
VISIBILITY="${3:-public}"

if [[ -z "$OWNER" ]]; then
  echo "Usage: $0 <owner> [repo-name] [public|private]" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is not installed. Install it and run 'gh auth login' first." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

REPO_SLUG="${OWNER}/${REPO_NAME}"
CURRENT_DIR="$(pwd)"

echo "Creating GitHub repository ${REPO_SLUG} (${VISIBILITY}) and pushing current repo..."

gh repo create "$REPO_SLUG" --source "$CURRENT_DIR" --${VISIBILITY} --push

echo "Done."
