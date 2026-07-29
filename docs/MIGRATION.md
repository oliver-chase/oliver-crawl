# Provenance

This library was extracted from a production events app's ingestion layer. This page records what moved, what did not, and why — so a reader can tell a deliberate boundary from unfinished work.

Nothing has been removed from the origin app. The library is additive until a consumer swaps over and its own suite passes, which keeps rollback to a single revert.

## Migrated (done, with tests)

| Capability | Here | Notes |
|---|---|---|
| SSRF / DNS-rebinding guard | `fetch/host-policy.ts` | Decoupled from the origin app's 25-field database row onto `CrawlTarget`. Every origin test ported, plus coverage for the new fail-closed robots rule |
| IP/private-range classification | `core/net-address.ts` | Existed **twice** in the origin repo (`crawl-source-policy.ts` + `input-validation.ts`) with different call sites. Consolidated to one home |
| Prompt-injection guard | `guard/prompt-injection-guard.ts` | Unchanged |
| JSON-LD event extraction | `extract/jsonld-event.ts` | Unchanged |
| JSON-LD address extraction | `extract/jsonld-address.ts` | Unchanged |
| Content-region hashing | `extract/content-region-hash.ts` | Unchanged |
| SPA inline-payload recovery | `extract/spa-content-extract.ts` | Unchanged |
| Jina Reader fallback | `fetch/jina-fetch.ts` | Unchanged |
| Cross-runtime SHA-256 | `core/hash.ts` | `createRandomId` dropped — not crawl-related |
| URL safety for extracted values | `core/url-safety.ts` | Now shares `net-address` with the SSRF guard |
| **Lane orchestration** | `index.ts`, `lanes/*` | New. Did not exist in the origin — lanes were implicit |
| robots.txt fetching + parsing | `fetch/robots-check.ts` | Bot identity is derived from the configured User-Agent (`userAgentToken`) rather than a a hardcoded bot token, so a consumer's robots group matches the agent it actually sends |
| ICS/feed discovery | `fetch/feed-discovery.ts` | Unchanged besides UA/DNS injection |
| Pagination discovery | `extract/pagination-discovery.ts` | Unchanged |
| Extraction recipes (REPLAY half) | `extract/extraction-recipe.ts` | `applyRecipe` + `parseStoredRecipe` only — see below |
| Browser render rung | `fetch/browser-render.ts` | Placed in the OWN lane, not vendor: the endpoint is infrastructure the consumer runs. Env vars replaced by `config.browserRender`; `logUsage` replaced by the `onUsage` callback |
| Cheap-change probe | `fetch/cheap-change-probe.ts` | ETag/Last-Modified/body-hash fingerprint. The re-crawl loop is now WIRED: `crawlSite` returns per-URL validators and calls `onSignals`, and conditional-GET headers are actually sent (see CRAWL-VALIDATE-1 below) |
| **Multi-page orchestrator** | `crawl-site.ts` | Seeds, page budget, per-URL retry with terminal-failure awareness, dedup (incl. pagination loop-backs), optional pagination following. Sequential like the original (`maxConcurrency: 1`) — politeness is a feature |
| **Search (Tavily + Serper)** | `search/index.ts` | Its own surface, not a crawl lane. Returns an OUTCOME, not a bare array, so "no key configured" / "budget refused" / "genuinely nothing" stay distinguishable. Provider results are run through `isSafeHttpUrl`, so a `javascript:` or metadata-host link cannot reach a caller |
| Free local render rung | `fetch/local-render.ts` | Local headless Chromium, tried BEFORE the remote render service — makes JS rendering free on any machine with `npx playwright install chromium`. Untraceable import so it never breaks a bundler; degrades silently where absent |
| Sitemap discovery | `fetch/sitemap-discovery.ts` | NEW capability (not in the origin): reads `/sitemap.xml`, follows index files one level, same-site-filters every URL. Free "what pages does this site have" |

## Hardening pass (self-audit)

Reviewing my own work found four real gaps, all fixed with red-capable tests:
- **CRAWL-VALIDATE-1** — conditional-GET headers were never sent. The lane accepted `etag`/`lastModified`, documented the free-304 path, and had the 304 branch — but no `If-None-Match`/`If-Modified-Since` ever went on the wire, so the whole re-crawl-efficiency story was dead against a real origin. The 304 test only passed because its stub returned 304 unconditionally. Now sent; verified live (a real origin returned 304 on the second crawl).
- **CRAWL-HARDEN-1** — response bodies were read unbounded. `response.text()` buffers everything, so a hostile/misconfigured origin streaming an endless body was a memory-exhaustion DoS on the crawler. Now capped at 2 MB, truncating rather than failing.
- **CRAWL-PERF-1** — `buildPage` reloaded the whole document once per JSON-LD `<script>` tag (N+1 full cheerio parses). Now one parse.
- **Dead API** — `config.onSignals` existed but nothing ever called it. Moved to `SiteCrawlOptions` where the orchestrator actually invokes it, and the return value carries the same validators.

**Typecheck clean (strict), builds to dist, verified against live sites** (iana.org, rfc-editor.org; incl. a real multi-page run and a live conditional-GET 304 round-trip). Current test and live-check counts live in the [README's Status section](../README.md#status) — one home, so they cannot drift apart.

## Not yet migrated

| Capability | Origin file |
|---|---|
| Extraction recipes (LEARN half) | `extraction-recipe.ts` |

## Staying in the origin app permanently

Domain logic, correctly. `event-dedup` (912 lines), `date-text-parser` (527), `promote-core` (720), `recurring-schedule`, every `*-filter.ts` and `auto-publish` all encode what the origin app means by an event — rules no other consumer shares. `ingestion-worker.ts` (1,608) is the orchestrator that *consumes* this library rather than something to move into it.

The test of whether something belongs here is simple: would a consumer in a different domain want it unchanged? Reading a page, yes. Deciding whether two rows describe the same thing, no.

## Adoption order

1. **The origin app** — where the code came from; swap module-by-module, suite green at each step.
2. **OSG** — `sdr/scripts/shared/web-research.js` (389 ln, CommonJS) duplicates the same providers. Porting it proves the package works outside its origin.
3. **A notes app** — no crawl code today; adopt if/when it needs one.
4. **Oliver Studios** — Python. Cannot consume an npm package; needs the HTTP wrapper, and only if it turns out to be worth it for one caller.

## Rules for the swap

- **Copy, verify, then delete.** the origin app keeps its originals until its suite passes against this package.
- **Pin exact versions** in consumers (`"@oliver/crawl-core": "0.1.0"`, no `^`) so a package change can never silently alter a consumer's crawl behaviour.
- **Tests move with their module.** They are the evidence the extraction preserved behaviour — that is why the 45-test SSRF suite came over first.

---

**See also:** [DECISIONS](DECISIONS.md) — why the code is the way it is · [README](../README.md) · [ARCHITECTURE](ARCHITECTURE.md) — where each module lives now · [EXISTING-PROJECTS](EXISTING-PROJECTS.md) — the swap procedure · [BACKLOG](BACKLOG.md) — what is still open
