# oliver-crawl — Backlog (open work only)

> **Policy: history lives in git, not here.** An entry leaves this file the day
> its work ships — no archived or DONE sections. `git log --follow docs/BACKLOG.md`
> for what came before.

Opened 2026-07-27 from a full security / QA / functionality audit of the
package against Fallow, the repo it was extracted from. Fallow has ~78
ingestion modules; roughly 20 were migrated. Everything below is a capability
that exists there (or should exist here) and does **not** exist here yet.

Each entry is a **spec, not a build**. Nothing below has been implemented.

---

## Vendor parity — the actual bar

The goal is not "lane 1 runs first." It is **lane 1 making lane 2 unnecessary**.
Measured against what the paid APIs actually do:

| Vendor capability | Status here | Free-achievable? |
|---|---|---|
| Markdown output, `onlyMainContent` | **shipped** 2026-07-27 | Yes |
| `Crawl-delay` compliance | **shipped** 2026-07-27 | Yes |
| "Do I even need an LLM?" signal | **shipped** 2026-07-27 — vendors do NOT offer this | Yes |
| Whole-site crawl, depth/limits | shipped | Yes |
| Change tracking / caching | shipped (conditional GET + region hash + sitemap lastmod) — better than Firecrawl's `maxAge`: lastmod covers a whole site in ONE request | Yes |
| JS rendering | shipped (local Chromium + own service) | Yes |
| `/map` — fast whole-domain URL discovery | **shipped** 2026-07-27 (`mapSite`) | Yes |
| Browser actions (click "load more", scroll, wait) | **shipped** 2026-07-27 | Yes |
| Feeds / calendars / CSV / JSON as first-class documents | **shipped** 2026-07-27 (CRAWL-FEED-1) | Yes |
| PDF parsing | **CRAWL-PDF-1** below | Yes |
| Screenshots | not planned — no consumer needs it yet | Yes |
| Consistent polite-client headers (free half of stealth) | **shipped** 2026-07-27 — accept-language + full accept; sec-ch-ua deliberately excluded (a half-consistent browser disguise is a stronger tell than none) | Yes |
| Readability-class content scoring for div-soup pages | **shipped** 2026-07-27 | Yes |
| Residential proxies | **not achievable free** — lane 2 keeps this | No |
| General web search (Serper/Tavily) | **not achievable free** — see note | No |
| Apify actor marketplace | not a capability gap; a different ops model | n/a |

**On search, honestly:** free SERP scraping (DuckDuckGo HTML, etc.) is fragile
and terms-of-service grey, and building on it would make the package's most
security-conscious surface its least reliable one. The right move is to reduce
DEPENDENCE on search — `/map`, sitemap and feed discovery answer "what pages
does this site have" without asking a search engine at all — not to fake a
free search rung.

---

## Where we can beat the vendors, not just match them

The vendors optimise **crawl** cost. Their API is stateless and per-call, so
they structurally cannot do any of the below. We run in-process and hold state
across runs, and the consumer's real bill is the LLM extraction AFTER the
crawl — so this is where the leverage is.

---

## CRAWL-PDF-1 — PDFs are still refused

Split out of CRAWL-FEED-1, which shipped everything text-shaped. PDFs remain
refused because they need a real parser, not a wider content-type gate — many
venues publish season schedules as a single PDF.

**Spec.** Accept `application/pdf`, extract the text layer, deliver as
`contentKind: 'pdf'`. Needs a dependency (`unpdf` or similar, ESM + no native
build); audit it for the same ReDoS/injection concerns as everything else
here. A scanned PDF has no text layer and should report `empty` honestly
rather than returning a blank page — that case belongs to CRAWL-VISION-1.

---

## CRAWL-PARITY-1 — extraction parity with Fallow's cheerio runner is unverified

Fallow's `secure-crawlee-runner.ts` (515 lines) extracts with cheerio.
oliver-crawl uses its own parser. **Nobody has compared their output on the
same pages.** The migration assumed parity and never demonstrated it.

This matters before Fallow is wired to consume the package: a silent extraction
regression across every source is the exact failure this repo exists to avoid,
and it would look like a data-quality drift rather than a code bug.

**Spec.** A differential harness — run N real Fallow source URLs through both,
diff text length, title, link count, JSON-LD node count. Every disagreement
gets explained before any swap. `docs/EXISTING-PROJECTS.md` already prescribes
exactly this procedure for consumers; the package has not run it on itself.

---

## Live tracker

| Date | Entry | Change |
|---|---|---|
| 2026-07-27 | file created | Nine specs opened from the post-extraction audit against Fallow. None implemented. |
| 2026-07-27 | PARITY-ACTIONS-1 | SHIPPED, spec removed. `browserActions` on config, local-render rung only. Bounds are library constants a caller cannot raise: 10 actions, 20s total, 5s per wait. Origin re-checked after every step — ablation-verified. Failed step skipped (a missing "Load more" means the list already loaded). Tests drive `runActions` directly: playwright is not a dependency and its import is deliberately invisible to bundlers, so the module cannot be mocked. |
| 2026-07-27 | backlog batch | SHIPPED 5: CRAWL-VISION-1 (candidateContentImages, free half only — ranking not a verdict), CRAWL-DETAILLINK-1 (pickDetailLinks, caller supplies vocabulary), BETTER-DIFF-1 (diffContent, set-based so reordering is not a change), CRAWL-CONCURRENCY-1 (searchAndCrawl concurrency, safe because host-throttle already serialises per host; default 1). CRAWL-SESSION-1 CLOSED AS DOCUMENTED, not built — a cookie jar is a credential store and the spec itself called documenting the honest answer. |
| 2026-07-27 | BETTER-RUNGMEMORY-1 | SHIPPED, spec removed. Per-host winning rung, 30min TTL, recorded at one chokepoint in crawl(). Store is PER CRAWLER — first cut was module-level and broke 10 tests, same defect class as HOST-CACHE-SCOPE-1. Self-heals: a failed remembered rung is forgotten and the full ladder re-runs, else a rung outage would cost the page. `rungMemory: false` opts out. |
| 2026-07-27 | PARITY-MAP-1 | SHIPPED, spec removed. mapSite(crawler, target) = sitemap + homepage links + declared feeds, ONE page body fetched. Feeds surfaced separately. Live: 25 urls off rfc-editor. Live gap: maxUrls filled from sitemap alone there, so the homepage-links path is fixture-covered only. |
| 2026-07-27 | consumer signals | SHIPPED 4 specs, all removed: CRAWL-DEGRADE-1 (failureClass transient/structural, classified at one chokepoint in crawl()), BETTER-SOFT404-1 (likelyEmptyState, advisory only), CRAWL-CONTENTKIND-1 (extractorVersion stamp), CRAWL-UA-1 (warn once per UA with no contact, never throw). 22 new tests. |
| 2026-07-27 | CRAWL-RESUME-1 | SHIPPED, spec removed. onProgress emits CrawlProgress{queue,visited,depths,collected}; resumeFrom restores it. No storage in the package. Ablation note: removing `visited` restore ALONE stays green because `depths` also blocks re-enqueue — the two overlap for dedup. Removing both turns 3 tests red. |
| 2026-07-27 | README | Fixed a wrong claim (said `text` had nav stripped — that is `markdown`), added markdown/structuredData/contentKind/lastmod, corrected 317 -> 432 tests. Counts taken from a real run. |
| 2026-07-27 | BETTER-LASTMOD-1 | SHIPPED, spec removed. SitemapEntry{url,lastmod}; crawlSite priorLastmod skips unfetched; returns lastmod + skippedByLastmod. Skip-only by design (lastmod lies). Ablation-verified. Live gap: rfc-editor publishes no lastmod, so real-sitemap extraction is fixture-covered, shape-only live. |
| 2026-07-27 | CRAWL-FEED-1 | SHIPPED, spec removed. contentKind on CrawlPage; ICS/CSV/JSON/RSS/Atom/XML delivered verbatim; images+binaries still refused; guard runs on every kind. PDF split out as CRAWL-PDF-1. |
| 2026-07-27 | review fixes | CACHE-POLICY-1 (cache read ran before the policy gate; cache is keyed on url+lanes, not target — a second target could read a page it was never allowed to fetch) and READABILITY-CHROME-1 (scoring ran before chrome removal, so a prose-heavy aside/nav could win and the later strip could not undo it). Both ablation-verified red first. |
| 2026-07-27 | process | `npm run check` had been exiting 1 since the buildQuarantineTask cleanup left an orphan test file with no suite; masked by grepping the "Tests" line, which shows passing count and hides a failed SUITE. Read the exit code. |
| 2026-07-27 | PARITY-HEADERS-1 + PARITY-READABILITY-1 | SHIPPED, specs removed per policy. Headers: accept-language + richer accept on the direct-fetch rung; accept-encoding left runtime-owned on purpose. Readability: paragraphs-vote-for-parent scoring as the no-semantic-tag fallback, 40% mass guardrail, ablation-verified. v0.2.0 tagged; update flow documented in EXISTING-PROJECTS.md. |
| 2026-07-27 | VENDOR-POLICY-1 | SHIPPED same day as found: crawl() now runs eligibility+robots+same-site lane-independently; vendor-only crawls were previously entirely unvetted. Ablation-verified (4 tests red without gate). |
| 2026-07-27 | cleanup | DELETED buildQuarantineTask + tests (remove-don't-archive): Fallow's curation-task shape, zero consumers here, belongs in Fallow at wiring time. |
| 2026-07-27 | external-tools honesty | Firecrawl/ScrapeGraphAI/Crawlee audited at API/architecture level, NOT full source. Their free techniques we lack are now specs: PARITY-READABILITY-1, PARITY-HEADERS-1, CRAWL-RESUME-1. |
| 2026-07-27 | shipped | Crawl-delay honoured (ROBOTS-DELAY-1) + WHITE-LABEL-2 FallowBot strings removed from output. Structured-data signal shipped (JSONLD-SIGNAL-1). |
| 2026-07-27 | beat-the-vendors | Four specs opened for things a stateless per-call API structurally cannot do: BETTER-LASTMOD-1, BETTER-RUNGMEMORY-1, BETTER-DIFF-1, BETTER-SOFT404-1. |
| 2026-07-27 | vendor parity | Reframed around displacing the paid APIs, not just matching Fallow. Markdown + onlyMainContent SHIPPED. PARITY-MAP-1 and PARITY-ACTIONS-1 opened. Recorded that proxies/stealth and general web search are genuinely not free-achievable. |
