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
| robots.txt fetching + parsing | `fetch/robots-check.ts` | 21 | Bot identity is now DERIVED from the configured User-Agent (`userAgentToken`) instead of a hardcoded `fallowbot`, so a consumer's robots group matches the UA it actually sends. That derivation was new, so it got its own 4 tests |
| ICS/feed discovery | `fetch/feed-discovery.ts` | 14 | Unchanged besides UA/DNS injection |
| Pagination discovery | `extract/pagination-discovery.ts` | 13 | Unchanged |
| Extraction recipes (REPLAY half) | `extract/extraction-recipe.ts` | 5 | `applyRecipe` + `parseStoredRecipe` only — see below |
| Browser render rung | `fetch/browser-render.ts` | 12 | Placed in the OWN lane, not vendor: the endpoint is infrastructure the consumer runs. Env vars replaced by `config.browserRender`; `logUsage` replaced by the `onUsage` callback |
| Cheap-change probe | `fetch/cheap-change-probe.ts` | (via lane) | ETag/Last-Modified/body-hash fingerprint. The re-crawl loop is now WIRED: `crawlSite` returns per-URL validators and calls `onSignals`, and conditional-GET headers are actually sent (see CRAWL-VALIDATE-1 below) |
| **Multi-page orchestrator** | `crawl-site.ts` | 15 | Seeds, page budget, per-URL retry with terminal-failure awareness, dedup (incl. pagination loop-backs), optional pagination following. Sequential like the original (`maxConcurrency: 1`) — politeness is a feature |
| **Search (Tavily + Serper)** | `search/index.ts` | 15 | Its own surface, not a crawl lane. Returns an OUTCOME, not a bare array, so "no key configured" / "budget refused" / "genuinely nothing" stay distinguishable. Provider results are run through `isSafeHttpUrl`, so a `javascript:` or metadata-host link cannot reach a caller |
| Free local render rung | `fetch/local-render.ts` | 3 | Local headless Chromium, tried BEFORE the remote render service — makes JS rendering free on any machine with `npx playwright install chromium`. Untraceable import so it never breaks a bundler; degrades silently where absent |
| Sitemap discovery | `fetch/sitemap-discovery.ts` | 7 | NEW capability (not in the origin): reads `/sitemap.xml`, follows index files one level, same-site-filters every URL. Free "what pages does this site have" |

## Hardening pass (2026-07-27 self-audit)

Reviewing my own work found four real gaps, all fixed with red-capable tests:
- **CRAWL-VALIDATE-1** — conditional-GET headers were never sent. The lane accepted `etag`/`lastModified`, documented the free-304 path, and had the 304 branch — but no `If-None-Match`/`If-Modified-Since` ever went on the wire, so the whole re-crawl-efficiency story was dead against a real origin. The 304 test only passed because its stub returned 304 unconditionally. Now sent; verified live (a real origin returned 304 on the second crawl).
- **CRAWL-HARDEN-1** — response bodies were read unbounded. `response.text()` buffers everything, so a hostile/misconfigured origin streaming an endless body was a memory-exhaustion DoS on the crawler. Now capped at 2 MB, truncating rather than failing.
- **CRAWL-PERF-1** — `buildPage` reloaded the whole document once per JSON-LD `<script>` tag (N+1 full cheerio parses). Now one parse.
- **Dead API** — `config.onSignals` existed but nothing ever called it. Moved to `SiteCrawlOptions` where the orchestrator actually invokes it, and the return value carries the same validators.

**317 tests, typecheck clean (strict), builds to dist, verified against live sites** (example.com, iana.org, rfc-editor.org; incl. a real multi-page run and a live conditional-GET 304 round-trip).

## Not yet migrated

| Capability | Origin file | Why it is harder |
|---|---|---|
| Extraction recipes (LEARN half) | `extraction-recipe.ts` | **Stays in Fallow, permanently.** `learnRecipe` calls an LLM to propose selectors; `validateRecipeDrafts` gates them with event-domain rules (`parseDateText`, `looksLikeAddress`). A different consumer must learn against ITS own domain's validity rules. The replay half has moved |

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
