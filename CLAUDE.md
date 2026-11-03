> Framework rules (voice, practice, gates, skill placement) load automatically from
> `~/.claude/CLAUDE.md`, which symlinks into OliverCode. Resolve OliverCode's own path with
> `dirname "$(readlink ~/.claude/CLAUDE.md)"` when you need a file from it. This file carries
> only what is specific to this repo.

# oliver-crawl — Agent Rules

Run `bash scripts/validate.sh` before commit — it is this repo's canonical validation. It runs
the commit gates, the structure contract check, the repo-local gates and `npm run check`
(typecheck, tests, the comment budget, and the decisions ledger), and it exits non-zero when any
of them fails.

Read `docs/repo-structure-contract.md` and `docs/backlog-config.json` before working here.

**This repo is public, and a consumer's deploy depends on it staying that way.** A
downstream app installs it as a git dependency, and npm resolves a GitHub dependency to
`git+ssh` in the lockfile. An edge build host has no ssh key, so the install only works
because npm falls back to https — and that fallback needs anonymous read. While this repo
was private, that consumer's build failed at `npm clean-install` with
`Permission denied (publickey)`. Making it private again breaks that build, and no change
to the dependency spec avoids it: npm normalises `git+https://` to ssh either way.

Comment density runs above the fleet guideline by design — see `.comment-budget.json`. The
exported types and functions are the contract a consumer reads, so their fields carry the
decisions. Block length is what actually fails.

Open work lives in the `oliver-crawl` GitHub Project. `docs/backlog-config.json` names it.
`backlog-management` governs it. `docs/BACKLOG.md` no longer exists. Git log holds the
resolved entries it used to carry. The one genuinely open item is now an issue on the Project.
