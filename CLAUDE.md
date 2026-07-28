> Framework rules (voice, practice, gates, skill placement) load automatically from
> `~/.claude/CLAUDE.md`, which symlinks into OliverCode. Resolve OliverCode's own path with
> `dirname "$(readlink ~/.claude/CLAUDE.md)"` when you need a file from it. This file carries
> only what is specific to this repo.

# oliver-crawl — Agent Rules

Run `npm run check` before commit. This repo has no `scripts/validate.sh`; `check` is its
canonical validation and runs typecheck, tests, the comment budget, and the decisions ledger.

Comment density runs above the fleet guideline by design — see `.comment-budget.json`. The
exported types and functions are the contract a consumer reads, so their fields carry the
decisions. Block length is what actually fails.
