# oliver-crawl — Backlog (open work only)

> **Policy: history lives in git, not here.** An entry leaves this file the day
> its work ships — no archived or DONE sections. `git log --follow docs/BACKLOG.md`
> for what came before.

**No open specs.** Everything opened by the 2026-07-27 audit has shipped; the
tracker below records what each entry was and how it was resolved.

That is a statement about this list, not about the library. Two things remain
true and are recorded here because they are the next real decisions, not
because they are queued work:

- **No consumer has adopted this yet.** Fallow and tesknota still run their own
  crawling code. `scripts/parity-check.mjs` exists to gate that swap: run it and
  the consumer's existing extractor over the same URLs, and explain every
  disagreement before changing anything. A silent extraction difference across
  every source does not read as a bug — it reads as the data getting worse.
- **Residential proxies and general web search stay paid.** Both were assessed
  and neither is free-achievable. See the parity table.

New work belongs here as a spec before it is built.

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
| PDF parsing | **shipped** 2026-07-27 (optional peer) | Yes |
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

## Where this beats the vendors rather than matching them

A per-call vendor API is stateless, so it cannot carry knowledge from one page
to the next or from one run to the next. Running in-process can. Four shipped
capabilities come from that difference, and none has a vendor equivalent:

| Capability | What it exploits |
|---|---|
| Sitemap `lastmod` skipping | One request reports which of a site's pages changed; a per-page API must ask per page |
| Per-host rung memory | A host that always rejects the plain fetch is remembered, so the wasted request stops after the first page |
| Content diff | Both versions are held here, so a consumer can re-extract the delta instead of the page |
| Structured-data signal | Reports whether a model is needed at all, which a paid extraction API has no incentive to answer |

---

## First real parity run — 2026-07-27

`scripts/parity-check.mjs` against 20 of Fallow's highest-yield active sources
(`source_providers`, ordered by `published_series_count`). Read-only.

**Result: 20/20 read.** Findings, in order of consequence:

**A guard false positive, now fixed (MARKDOWN-DATAURI-1).** One live site was
quarantined. The cause was in code shipped the same day: the markdown
converter emitted `![](data:image/png;base64,…)` for inline images, and a 1×1
base64 placeholder — the standard lazy-loading pattern — tripped the
encoded-payload rule. Plain text never hit this because images are not in
text. Left alone it would have silently quarantined most of the web. Data
URIs are no longer emitted, `data-src` is preferred when a lazy-loader parked
the real URL there, and alt text is kept.

**60% of these sources need no model at all.** 12 of 20 publish usable
structured data (`hasContentData`). That is the largest cost lever available
to a consumer and it is free to act on.

**4 of 20 only succeeded via the Jina rung**, meaning the direct fetch failed.
Those return `contentKind: 'text'` — no markdown, no JSON-LD, no links — so
they lose the free extraction path and fall through to a model.
`themishawaka.com`, `cfdrodeo.com`, `visitgolden.com`, `aspensnowmass.com`.

**The localRender hypothesis was tested and was half right.** With Chromium
installed, two of the four (`visitgolden`, `aspensnowmass`) upgrade from the
Jina rung to full HTML with markdown. The other two remain Jina-only.

Testing it surfaced a worse defect than the one being investigated
(LADDER-QUALITY-1, fixed). On `cfdrodeo.com` the render rung captured
Cloudflare's "Why have I been blocked?" interstitial, and the ladder accepted
it because rung acceptance only asked whether any text came back. A
300-character security notice therefore beat the Jina rung, which retrieves
the real page — the crawl reported SUCCESS while delivering the wall. After
the fix that source returns 2,845 characters of real content instead of 747
characters of block page.

A consumer should enable `localRender`: it is free, it upgrades sources that
would otherwise lose markdown and JSON-LD, and it never makes a source worse
now that a rendered wall is treated as a rung failure.

**One transient failure, not a dead source.** `visitgolden.com/events/...`
returned 404 on the first run and 301 on the second. Worth remembering when
reading any single run: `failureClass: transient` exists for this.

---

## Live tracker

| Date | Entry | Change |
|---|---|---|
| 2026-07-27 | MARKDOWN-DATAURI-1 | FIXED. Markdown emitted base64 data-URI image srcs, tripping the injection guard's encoded-payload rule and quarantining ordinary pages. Found by the first live parity run, not by the test suite — introduced and caught the same day. |
| 2026-07-27 | LADDER-QUALITY-1 | FIXED. A bot-wall interstitial served with HTTP 200 (or captured by a render rung) was accepted as page content, so a security notice outranked the rung holding the real page. Rung acceptance now rejects block pages and continues the ladder. Found only by running against live sites with localRender on; ablation-verified. |
| 2026-07-27 | parity run 1 | 20/20 read after the fix. 12/20 need no model. 4/20 only reachable via Jina and therefore lose markdown + JSON-LD; localRender as a remedy is UNVERIFIED (playwright absent here). |
| 2026-07-27 | file created | Nine specs opened from the post-extraction audit against Fallow. None implemented. |
| 2026-07-27 | CRAWL-PDF-1 | SHIPPED, spec removed. `unpdf` is an OPTIONAL peer, not a dependency: a parser is a large hostile-input surface, and putting it in every install for the minority who crawl PDFs is the wrong trade here. Same Function-constructor import seam as playwright. Missing parser reports a `structural` failure naming the package. Found a real gap doing it — a missing parser and a scanned PDF were both classed `transient` when neither is fixed by waiting. |
| 2026-07-27 | CRAWL-PARITY-1 | SHIPPED as `scripts/parity-check.mjs`, spec removed. Reports per-URL extraction shape (counts + hashes, not prose) so a consumer can diff it against their existing extractor on the same list. Deliberately NOT coupled to any consumer — this library must not import Fallow or tesknota. Run before any swap; explain every disagreement first. |
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

---

**See also:** [README](../README.md) · [ARCHITECTURE](ARCHITECTURE.md) · [LANES](LANES.md) · [REFERENCE](REFERENCE.md) · [MIGRATION](MIGRATION.md) — what moved here and what did not
