# Repo structure contract

Status: Active

## Canonical contract sources

1. `OliverCode/docs/RULES.md` ("Project structure")
2. `OliverCode/docs/CONTRACT.md`

## Profile

This repo uses the GitHub Project backlog profile. Its backlog is the GitHub Project named
in `docs/backlog-config.json`, read and written by the `backlog` skill.

## Required structure

1. Root docs:
- `README.md`
- `CLAUDE.md`
- `docs/repo-structure-contract.md`
2. Backlog:
- `docs/backlog-config.json` — the `backlog` skill's config for this repo's Project

## Backlog and evidence paths

1. Active backlog source: the GitHub Project named in `docs/backlog-config.json`
2. Story catalog source: the GitHub Project's issue list
3. Acceptance test matrix source: `N/A (each issue carries AC/test evidence directly)`

## Branches

This repo works on `main`, and every change lands through a pull request from a branch.

## Enforcement

1. `bash scripts/validate.sh` runs the commit gates, the structure contract check and `npm run check` (typecheck, tests, comment budget and decisions ledger)
2. `.githooks/pre-commit` runs the commit gates on every commit, with `core.hooksPath` set to `.githooks`

## Contract exceptions

- hooks: the shared hook has no slot for this repo's two local gates, the `.private-patterns` string scan and `scripts/check-backlog-hygiene.mjs`, so `scripts/validate.sh` runs both and the commit hook does not. Expires 2027-02-01
