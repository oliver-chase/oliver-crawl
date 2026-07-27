# Migration status

Where each capability from the origin codebase (Fallow, `lib/ingestion/*`) stands. Nothing has been deleted from Fallow yet — this package is **additive** until a consumer swaps over and its suite passes green. That is what makes rollback a one-commit revert.

## Migrated (done, with tests)

| Capability | Here | Tests | Notes |
|---|---|---|---|
| SSRF / DNS-rebinding guard | `fetch/host-policy.ts` | 46 | Decoupled from Fallow's 25-field DB row onto `CrawlTarget`. All 45 origin tests ported and passing, plus one for the new fail-closed robots rule |
| IP/private-range classification | `core/net-address.ts` | (via above) | Existed **twice** in the origin repo (`crawl-source-policy.ts` + `input-validation.ts`) with different call sites. Consolidated to one home |
| Prompt-injection guard | `guard/prompt-injection-guard.ts` | 2 | Unchanged |
| JSON-LD event extraction | `extract/jsonld-event.ts` | 30 | Unchanged |
| JSON-LD address extraction | `extract/jsonld-address.ts` | 9 | Unchanged |
| Content-region hashing | `extract/content-region-hash.ts` | 10 | Unchanged |
| SPA inline-payload recovery | `extract/spa-content-extract.ts` | 5 | Unchanged |
| Jina Reader fallback | `fetch/jina-fetch.ts` | 8 | Unchanged |
| Cross-runtime SHA-256 | `core/hash.ts` | (via above) | `createRandomId` dropped — not crawl-related |
| URL safety for extracted values | `core/url-safety.ts` | (via above) | Now shares `net-address` with the SSRF guard |
| **Lane orchestration** | `index.ts`, `lanes/*` | 14 | New. Did not exist in the origin — lanes were implicit |

**124 tests, typecheck clean, verified against live sites** (example.com, iana.org).

## Not yet migrated

| Capability | Origin file | Why it is harder |
|---|---|---|
| Multi-page crawl orchestrator | `secure-crawlee-runner.ts` (515 ln) | Coupled to Fallow's source registry, extraction recipes, and `cheap-change-probe`. The single-page path is already here; this adds seeds, pagination and per-run budgeting |
| Browser render rung | `secure-browser-runner.ts` (503 ln) | Imports Fallow's usage-tracking **and** its source registry (a DB read). Needs both replaced by injected callbacks first |
| Extraction recipes | `extraction-recipe.ts` (201 ln) | **Splits.** `applyRecipe` + `parseStoredRecipe` are generic and movable; `learnRecipe` / `validateRecipeDrafts` call an LLM and validate with event-domain rules (`parseDateText`, `looksLikeAddress`) and must stay in Fallow. The original spec wrongly listed this module as fully generic |
| robots.txt fetching | `robots-check.ts` (212 ln) | Straightforward once `user-agent` config lands; depends on host-policy (already here) |
| Feed + pagination discovery | `feed-discovery.ts`, `pagination-discovery.ts` | Depend on robots-check and the crawl orchestrator |
| Search providers | `lib/ai/research.ts` (Tavily/Serper) | Search is a different shape from crawling (query in, results out). Belongs in this package but as its own surface, not a crawl lane |

## Staying in Fallow permanently

Event-domain logic, correctly: `event-dedup` (912 ln), `date-text-parser` (527), `promote-core` (720), `recurring-schedule`, every `*-filter.ts`, `auto-publish`, and `ingestion-worker.ts` (1,608) — the orchestrator that *consumes* this package rather than moving into it.

## Adoption order

1. **Fallow** — origin of the code; swap module-by-module, suite green at each step.
2. **OSG** — `sdr/scripts/shared/web-research.js` (389 ln, CommonJS) duplicates the same providers. Porting it proves the package works outside its origin.
3. **Tesknota** — no crawl code today; adopt if/when it needs one.
4. **Oliver Studios** — Python. Cannot consume an npm package; needs the HTTP wrapper, and only if it turns out to be worth it for one caller.

## Rules for the swap

- **Copy, verify, then delete.** Fallow keeps its originals until its suite passes against this package.
- **Pin exact versions** in consumers (`"@oliver/crawl-core": "0.1.0"`, no `^`) so a package change can never silently alter a consumer's crawl behaviour.
- **Tests move with their module.** They are the evidence the extraction preserved behaviour — that is why the 45-test SSRF suite came over first.
