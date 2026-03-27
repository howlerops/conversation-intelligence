#!/usr/bin/env bash
set -euo pipefail

REMOTE_URL="${1:-}"
BRANCH="${2:-main}"

if [[ -z "$REMOTE_URL" ]]; then
  echo "Usage: $0 <remote-url> [branch]" >&2
  echo "Example: $0 https://github.com/YOUR-USER/YOUR-REPO.git main" >&2
  exit 1
fi

if git remote get-url origin >/dev/null 2>&1; then
  echo "Removing existing origin remote..."
  git remote remove origin
fi

git remote add origin "$REMOTE_URL"
git push -u origin "$BRANCH"

echo "Done."
