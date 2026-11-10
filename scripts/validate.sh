#!/usr/bin/env bash
# validate.sh: this repo's canonical validation. Run `bash scripts/validate.sh` before every commit.
# Every step below runs and a failing step fails the script, so a red test suite never reads as a pass.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ -x .githooks/pre-commit ]]; then
  echo "=== validate: pre-commit gates ==="
  # The tree scan runs every gate over every tracked file, so validation sees what a commit would not.
  OLIVERCODE_SCAN_TREE=1 bash .githooks/pre-commit
fi

# Repo-local gate the shared hook does not carry: this repo is public, so the strings it must
# never contain live in a gitignored .private-patterns file and are checked against tracked files.
if [[ -f .private-patterns ]]; then
  echo "=== validate: private patterns ==="
  patterns="$(grep -v -e '^[[:space:]]*$' -e '^[[:space:]]*#' .private-patterns || true)"
  if [[ -n "$patterns" ]] && git grep -n -F -f <(printf '%s\n' "$patterns") -- . ':!.private-patterns'; then
    echo "validate: a tracked file contains a string listed in .private-patterns" >&2
    exit 1
  fi
fi

# typecheck, tests, comment budget and the decisions ledger
echo "=== validate: npm run check ==="
npm run check

echo "=== validate: passed ==="
