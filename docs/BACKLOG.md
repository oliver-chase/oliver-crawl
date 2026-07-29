# oliver-crawl — Backlog (open work only)

> **Policy: history lives in git, not here.** An entry leaves this file the day
> its work ships — no archived or DONE sections. `git log --follow docs/BACKLOG.md`
> for what came before.

**No open specs.** Everything opened by the 2026-07-27 audit has shipped; the
tracker below records what each entry was and how it was resolved.

That is a statement about this list, not about the library. Two things remain
true and are recorded here because they are the next real decisions, not
because they are queued work:

- **One consumer is wired; two are not.** one consumer depends on
  this package as `@oliver/crawl-core`, pinned to a git TAG and reached through
  a single seam (`sdr/scripts/shared/page-fetch.js`). A tag, not a branch, on
  purpose: a floating ref would let a mid-session commit here change a
  production crawl silently, and this library's failure mode is quietly thinner
  data. The cost is that shipping to a consumer is deliberate work — tag, bump
  the pin, install.

  Two other consumers still run their own crawling code.
  `scripts/parity-check.mjs` gates those swaps: run it and the consumer's
  existing extractor over the same URLs, and explain every disagreement before
  changing anything. A silent extraction difference across every source does not
  read as a bug — it reads as the data getting worse.
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

## Measured against real sources

Both extractors run over the same 60 random active sources in the origin app. This was
the gate on wiring any consumer, and it is answered.

| | Read |
|---|---|
| the origin app's own cheerio runner | 59/60 |
| oliver-crawl | 60/60 |

Median text-length ratio across the shared URLs: **0.98** — extraction agrees.

Every defect these runs exposed is fixed and recorded in the tracker below and
in [DECISIONS](DECISIONS.md). The pattern worth keeping: all of them were found
by running against live websites, none by the unit suite.

Re-run it with `node scripts/parity-check.mjs <urls-file>` before wiring any
consumer, and explain every disagreement before switching anything over.

## Live tracker

| Date | Entry | Change |
|---|---|---|
| 2026-07-28 | RENDER-HOP-2 | SHIPPED. QA found RENDER-HOP-1 never ran. `route.continue()` hands the request to Chromium's network stack, which follows 3xx internally and never shows the route handler the hops — driving `site -> off-site -> site` proved the handler saw ONE request while three responses arrived. The off-site server got a real request and the landing check passed because the chain came home. A guard present, correct, and never invoked. The rung now walks the chain itself with `maxRedirects: 0`, validating each hop BEFORE its request. Live-verified both ways: the off-site chain is refused and a same-site redirect still renders. |
| 2026-07-28 | QA findings on my own work | FIXED 5, all ablation-verified. A subresource test sliced to end-of-file and matched the OTHER branch's `route.abort()`, so RENDER-SUBRESOURCE-1 could be fully defeated with the suite green. A live check asserted page shape with no rung assertion, passing on the plain-fetch rung — the same vacuous-shape defect as the unit test it replaced. Another counted usage events without checking outcome, staying green with `onBlocked` unwired. The body-cap test used an ASCII payload, where a byte cap and a character cap are indistinguishable, so swapping in a character cap (which buffers the whole body and restores the exhaustion) kept it green. `isSecurityRefusal` stayed silent on fail-closed DNS refusals and reported Chromium's ordinary `ERR_BLOCKED_*` family as attacks. |
| 2026-07-28 | process | The QA pass found more in one afternoon than the 648-test suite has all week, and every finding was in code I had written and called verified the same day. Two of them were defects I had already fixed once, reintroduced in the fix. Static wiring tests prove a guard's TEXT is present; only driving a real browser proves it runs. |
| 2026-07-28 | RENDER-SUBRESOURCE-1 + RENDER-SILENT-1 | SHIPPED. Page JavaScript could fetch a CORS-permissive service on a private address and land the body in the DOM, where it survived into `page.content()`; subresource requests are now resolution-checked. Same-site is deliberately NOT applied to them — real pages load CDN assets and refusing those breaks ordinary rendering. Separately, the rung swallowed every outcome into `return null`, so an active redirect attack was indistinguishable from playwright not being installed; security refusals now emit a usage event and ordinary unavailability still does not. |
| 2026-07-28 | untested guards | Two guards had NOTHING protecting them. The test named for CRAWL-HARDEN-1 asserted `text.length <= maxTextChars`, which is the sanitiser's character cap, not the 2MB byte cap that stops memory exhaustion. The README claims the injection filter covers vendor-lane pages and no test had ever fed a payload through one. Both now covered, both ablation-verified. |
| 2026-07-28 | orphaned doc comments | Three JSDoc blocks sat above declarations they did not describe, so `limits`, `useArchiveFallback` and `renderViaLocalChromium` were each undocumented while appearing documented. One was introduced the same day by inserting a helper between a comment and its function; its text had also gone stale, still claiming null "always means skip this rung" after RENDER-SILENT-1 made that false. A detector over `src/` now returns nothing. |
| 2026-07-28 | PAGE-SHAPE-1 + live render coverage | CLOSED, one gap seen twice. The rung carrying the most security machinery had every guard tested in isolation and was never driven end to end; it cannot run in the unit suite, because the host guard correctly refuses the private addresses a local test server binds to. Three checks added to `npm run live`, forced onto the rung by setting `renderWhenTextBelow` above any real page length. Ablation-verified. PDF stays UNCOVERED on purpose: `unpdf` is an optional peer and is absent here, so a check that skips when it is missing would report coverage it does not have. |
| 2026-07-28 | process | Two self-inflicted defects in the above, both caught reviewing my own work. A unit test enabled localRender on a page whose direct fetch succeeded, so the rung never ran and it asserted the shape of a page some other rung produced — vacuous coverage committed into the file that exists to catch vacuous coverage. And a live check named "render refuses a redirect that leaves the site" drove a URL with no cross-site redirect, asserting a security property its body never tested. Both fixed same day. Every defect this session came from ablation or from driving real infrastructure; none from the 635 unit tests. |
| 2026-07-27 | PROBE-DNS-SEAM-1 | CLOSED. dnsLookup is now injectable, matching every other fetch path; the success path is unit-tested. Also deduplicated `sleep`, which existed in two modules. |
| 2026-07-27 | ROBOTS-4XX-1 | FIXED. RFC 9309 treats any 4xx on robots.txt as UNAVAILABLE — the crawler may access, and a 403 equals a 404. We allowed only 404/410 and failed closed on the rest, refusing 4 of 60 live sources that read fine once permitted. 429 stays excluded: rate limited is not unavailable. Live sample went 55/60 to 60/60. |
| 2026-07-27 | CRAWL-PARITY-1 | RESOLVED. Both extractors over the same 60 live sources: origin app 59/60, oliver-crawl 60/60 with the same stored-policy config, median text ratio 0.98. The gap was autoRobots vs a stored policy, not extraction. |
| 2026-07-27 | THIN-PAGE-1 | FIXED. A JS page shipping only nav and footer passed the "is the parse empty" check and never escalated to render — 1,232 chars fetched vs 5,519 rendered on a live site. `renderWhenTextBelow` opts in to escalating an implausibly short page; a render that returns less is discarded, so it never loses the page it had. |
| 2026-07-27 | docs | Every export documented in REFERENCE's API surface; seven were undocumented (fetchViaWayback, jinaEndpoint, useArchiveFallback, resolveTarget, diffContent, pickDetailLinks, findContentImages). |
| 2026-07-27 | GUARD-PRECISION-3 | FIXED. encoded-payload spanned URL paths (`/` is in its character class), quarantining a base64 placeholder and a CDN path. Rule now evaluated URL-free; strip runs before normalisation. |
| 2026-07-27 | ROBOTS-REDIRECT-1 | Fixed, then REVERSED on evidence. Refusing off-domain robots redirects cost 6 live sources to protect against 1 parked domain. Now followed, with the new host reported. Read rate 53 -> 49 -> 55 of 60. |
| 2026-07-27 | MARKDOWN-DATAURI-1 | FIXED. Markdown emitted base64 data-URI image srcs, tripping the injection guard's encoded-payload rule and quarantining ordinary pages. Found by the first live parity run, not by the test suite — introduced and caught the same day. |
| 2026-07-27 | LADDER-QUALITY-1 | FIXED. A bot-wall interstitial served with HTTP 200 (or captured by a render rung) was accepted as page content, so a security notice outranked the rung holding the real page. Rung acceptance now rejects block pages and continues the ladder. Found only by running against live sites with localRender on; ablation-verified. |
| 2026-07-27 | parity run 1 | 20/20 read after the fix. 12/20 need no model. 4/20 only reachable via Jina and therefore lose markdown + JSON-LD; localRender as a remedy is UNVERIFIED (playwright absent here). |
| 2026-07-27 | file created | Nine specs opened from the post-extraction audit against the origin app. None implemented. |
| 2026-07-27 | CRAWL-PDF-1 | SHIPPED, spec removed. `unpdf` is an OPTIONAL peer, not a dependency: a parser is a large hostile-input surface, and putting it in every install for the minority who crawl PDFs is the wrong trade here. Same Function-constructor import seam as playwright. Missing parser reports a `structural` failure naming the package. Found a real gap doing it — a missing parser and a scanned PDF were both classed `transient` when neither is fixed by waiting. |
| 2026-07-27 | CRAWL-PARITY-1 | SHIPPED as `scripts/parity-check.mjs`, spec removed. Reports per-URL extraction shape (counts + hashes, not prose) so a consumer can diff it against their existing extractor on the same list. Deliberately NOT coupled to any consumer — this library must not import any consumer. Run before any swap; explain every disagreement first. |
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
| 2026-07-27 | cleanup | DELETED buildQuarantineTask + tests (remove-don't-archive): the origin app's curation-task shape, zero consumers here, belongs in the origin app at wiring time. |
| 2026-07-27 | external-tools honesty | Firecrawl/ScrapeGraphAI/Crawlee audited at API/architecture level, NOT full source. Their free techniques we lack are now specs: PARITY-READABILITY-1, PARITY-HEADERS-1, CRAWL-RESUME-1. |
| 2026-07-27 | shipped | Crawl-delay honoured (ROBOTS-DELAY-1) + WHITE-LABEL-2 vendor-branded strings removed from output. Structured-data signal shipped (JSONLD-SIGNAL-1). |
| 2026-07-27 | beat-the-vendors | Four specs opened for things a stateless per-call API structurally cannot do: BETTER-LASTMOD-1, BETTER-RUNGMEMORY-1, BETTER-DIFF-1, BETTER-SOFT404-1. |
| 2026-07-27 | vendor parity | Reframed around displacing the paid APIs, not just matching the origin app. Markdown + onlyMainContent SHIPPED. PARITY-MAP-1 and PARITY-ACTIONS-1 opened. Recorded that proxies/stealth and general web search are genuinely not free-achievable. |

---

**See also:** [DECISIONS](DECISIONS.md) — why the code is the way it is · [README](../README.md) · [ARCHITECTURE](ARCHITECTURE.md) · [LANES](LANES.md) · [REFERENCE](REFERENCE.md) · [MIGRATION](MIGRATION.md) — what moved here and what did not
