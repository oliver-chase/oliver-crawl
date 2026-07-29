> Framework rules (voice, practice, gates, skill placement) load automatically from
> `~/.claude/CLAUDE.md`, which symlinks into OliverCode. Resolve OliverCode's own path with
> `dirname "$(readlink ~/.claude/CLAUDE.md)"` when you need a file from it. This file carries
> only what is specific to this repo.

# oliver-crawl — Agent Rules

Run `npm run check` before commit — it is this repo's canonical validation and runs
typecheck, tests, the comment budget, and the decisions ledger. The framework's default
validate.sh filename does not exist here, so do not go looking for it.

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
