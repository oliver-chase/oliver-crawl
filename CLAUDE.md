> Framework rules (voice, practice, gates, skill placement) load automatically from
> `~/.claude/CLAUDE.md`, which symlinks into OliverCode. Resolve OliverCode's own path with
> `dirname "$(readlink ~/.claude/CLAUDE.md)"` when you need a file from it. This file carries
> only what is specific to this repo.

# oliver-crawl — Agent Rules

Run `npm run check` before commit — it is this repo's canonical validation and runs
typecheck, tests, the comment budget, and the decisions ledger. The framework's default
validate.sh filename does not exist here, so do not go looking for it.

Comment density runs above the fleet guideline by design — see `.comment-budget.json`. The
exported types and functions are the contract a consumer reads, so their fields carry the
decisions. Block length is what actually fails.
