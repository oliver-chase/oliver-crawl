# Quality baseline standard

This repository uses **shared, strict-managed quality files**.

Canonical source-of-truth (outside project docs):
- `OliverCode/core/templates/project/.github/CODEOWNERS`
- `OliverCode/core/templates/project/QUALITY_BASELINE.md`
- `OliverCode/docs/RULES.md`

## Rule

If one managed quality file changes in any project, the canonical file in `OliverCode` must be changed first and then synced to all projects. Runtime-minimal baseline lock is mandatory across managed repos. Local divergence is not the default path.

## Sync command

Run from OliverCode to deploy the current managed files and hooks to this repo:

```bash
scripts/olivercode sync-hooks
```

## Audit command

Run from OliverCode to check this repo against the contract:

```bash
scripts/olivercode conform <this repo's path>
```

Pre-commit gates (`.githooks/pre-commit`) must also pass before merging quality/workflow
policy edits.

## Lock enforcement

Managed repos must keep these shared enforcement surfaces wired exactly as shipped:
- `QUALITY_BASELINE.md` from the shared template
- `.githooks/pre-commit` from the shared template
- `git config core.hooksPath .githooks`
- workflow/template assets rendered from `shared/project-bootstrap-manifest.json`

After changing any baseline surface, run sync then audit before merge.

## Documentation

Every README and document in this repo follows the framework's documentation standard —
the locked README outline, voice, CAPS-KEBAB file naming, complete doc table, open-only
backlog, same-commit sync, and a filled-in GitHub About. The standard is
`docs/RULES.md` ("Documents") in the framework checkout, and `docs/VOICE.md` sets the words.
Ask an agent for a README here and that is the shape it produces.
