#!/usr/bin/env bash
# validate.sh: this repo's canonical validation. Run `bash scripts/validate.sh` before every commit.
# Every step below runs and a failing step fails the script, so a red test suite never reads as a pass.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ -x .githooks/pre-commit ]]; then
  echo "=== validate: pre-commit gates ==="
  bash .githooks/pre-commit
fi

if [[ -f scripts/check-structure-contract.mjs ]]; then
  echo "=== validate: structure contract ==="
  node scripts/check-structure-contract.mjs
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

echo "=== validate: backlog hygiene ==="
node scripts/check-backlog-hygiene.mjs --quiet

# typecheck, tests, comment budget and the decisions ledger
echo "=== validate: npm run check ==="
npm run check

echo "=== validate: passed ==="
