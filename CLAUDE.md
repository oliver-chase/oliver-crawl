> Framework rules (voice, practice, gates, skill placement) load automatically from
> `~/.claude/CLAUDE.md`, which symlinks into OliverCode. Resolve OliverCode's own path with
> `dirname "$(readlink ~/.claude/CLAUDE.md)"` when you need a file from it. This file carries
> only what is specific to this repo.

# oliver-crawl agent rules

Run `bash scripts/validate.sh` before commit — it is this repo's canonical validation. It runs
the commit gates, the structure contract check, the repo-local gates and `npm run check`
(typecheck, tests, the comment budget, and the decisions ledger), and it exits non-zero when any
of them fails.

Read `docs/repo-structure-contract.md` and `docs/backlog-config.json` before working here.

**This repo is public, and a consumer's deploy depends on it staying that way.** A
downstream app installs it as a git dependency, and npm resolves a GitHub dependency to
`git+ssh` in the lockfile. An edge build host has no ssh key, so the install only works
because npm falls back to https — and that fallback needs anonymous read. Making it private breaks that build with
`Permission denied (publickey)`, and no change to the dependency spec avoids it: npm
normalises `git+https://` to ssh either way.

The exported types and functions are the contract a consumer reads, so their fields carry the
decisions. `npm run check:comments` prints the density and fails on a comment block over 20 lines.

Open work lives in the `oliver-crawl` GitHub Project. `docs/backlog-config.json` names it.
`backlog` governs it, and git log holds the resolved entries.

**Managed files.** `.githooks/`, `scripts/size.sh`, `scripts/check-comment-budget.mjs`, `scripts/duplication_check.py`, `scripts/check-structure-contract.mjs`, `QUALITY_BASELINE.md` and `docs/repo-structure-contract.md` are copies of OliverCode's canonical files. Change them in OliverCode first and sync them here. Their references to OliverCode paths and to docs this repo lacks are expected.
