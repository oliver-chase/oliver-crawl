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
| Change tracking / caching | shipped (conditional GET + region hash) — arguably better than Firecrawl's `maxAge` | Yes |
| JS rendering | shipped (local Chromium + own service) | Yes |
| `/map` — fast whole-domain URL discovery | **PARITY-MAP-1** below | Yes |
| Browser actions (click "load more", scroll, wait) | **PARITY-ACTIONS-1** below | Yes — Chromium is already there |
| PDF parsing | **CRAWL-FEED-1** below (same content-type gap) | Yes |
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

## BETTER-LASTMOD-1 — site-wide change detection in one request

Sitemaps carry `<lastmod>` per URL. `fetch/sitemap-discovery.ts` fetches them
and throws that field away.

Conditional GET is one request per page to learn nothing changed. `lastmod` is
**one request for all 500 pages**. For a scheduled re-crawl that is the
difference between 500 round-trips and one, and no vendor offers it.

**Spec.** Capture `lastmod` in `SitemapDiscoveryResult`; accept a
`priorLastmod` map in `crawlSite` and skip any URL whose value has not moved.

**Watch out:** `lastmod` is origin-supplied and frequently lies — plenty of
CMSs stamp every URL with today's date. It may only ever be used to SKIP work,
never to assert a page did change, and a caller must be able to turn it off.
Pair it with the existing hash check rather than replacing that.

---

## BETTER-RUNGMEMORY-1 — remember which rung works for a host

Every crawl walks the ladder from the top. A host that always 403s the direct
fetch and always succeeds on render costs a guaranteed wasted request, every
page, forever.

**Spec.** Record the rung that succeeded per host and start there next time,
with the full ladder still available beneath it. Re-probe from the top
periodically so a site that stops blocking is not pinned to the expensive rung.

Strictly a latency and success-rate win, needs no new dependency, and a
stateless per-call vendor API cannot do it by construction.

---

## BETTER-DIFF-1 — report WHAT changed, not just THAT it changed

`unchanged` is a boolean. A consumer whose page gained one event re-extracts
the entire page — and pays for the whole thing to learn one row moved.

We hold both the previous validators and the new content. Handing over the
delta would cut re-extraction cost sharply, and re-extraction is the dominant
line item.

**Spec.** Optional `priorText`/`priorMarkdown` in, `changedRegions` out (added
and removed blocks). Markdown makes this far more tractable than flat text did,
since block boundaries are now explicit.

---

## BETTER-SOFT404-1 — don't pay to extract a page that says nothing

"No events scheduled at this time" is a perfectly valid 200 that costs a full
model call to learn nothing. So are parked domains, soft-404s, and "page under
construction".

**Spec.** A free heuristic — very low content length after main-region
scoping, boilerplate empty-state phrases, a title that matches a known 404
shape — surfaced as `CrawlPage.likelyEmptyState: boolean`. Advisory only:
never refuse to return the page, just let a caller skip paying for it.

**Watch out:** a real venue page in the off-season genuinely IS "no events
scheduled", and that is a true fact a consumer may want to record rather than
discard. This must inform the caller, never filter for them.

---

## PARITY-MAP-1 — fast whole-domain URL discovery

Firecrawl's `/map` returns hundreds of a domain's URLs in about one request.
Ours needs `crawlSite` with `followLinks`, which FETCHES every page to find the
next — minutes and hundreds of requests to answer a question that is mostly
already published.

**Spec.** `mapSite(target)` returning URLs without fetching each one: sitemap
(+ index files), feed URLs, and the link graph of the homepage only. No page
bodies, no parsing beyond hrefs. Cheap enough to run before deciding what a
real crawl should even target — and it makes `maxPages` a budget you spend
deliberately instead of one the queue order spends for you.

---

## PARITY-ACTIONS-1 — browser actions before capture

Firecrawl scripts the page before scraping: click, scroll, wait, type. The
common real case is a "Load more events" button or an infinite-scroll calendar
— pages where the FIRST render genuinely does not contain the content, so our
render rung returns a page that is technically correct and practically empty.

We already run Chromium (`fetch/local-render.ts`). The gap is purely that
nothing can be scripted before the capture.

**Spec.** `browserActions?: Array<{ type: 'click' | 'scroll' | 'wait'; selector?: string; ms?: number }>`
on the crawl options, executed by the local-render rung only.

**Watch out:** actions are caller-supplied instructions driving a real browser.
Cap the count and total duration, allow no navigation to another origin, and
never let an action come from crawled page content — that would be a
prompt-injection path straight into a browser we control.

---

## CRAWL-RESUME-1 — a killed crawlSite loses everything

`crawlSite`'s queue/visited/results live in memory only. A 500-page crawl
killed at page 400 restarts from zero. Crawlee persists its request queue to
disk for exactly this reason; Firecrawl runs async jobs you can re-poll.

**Spec.** Smallest honest version: `onProgress(state)` callback emitting
`{ queue, visited, collected }` snapshots, and `crawlSite` accepting a
`resumeFrom` of the same shape. No storage in the package — the consumer
persists it, same contract as validators. (Do NOT build a job system here.)

---

## CRAWL-FEED-1 — the package can discover a feed it cannot read

**Priority: highest. This is a half-capability, not a missing feature.**

`fetch/feed-discovery.ts` finds ICS calendar feeds — its own header argues they
are "MORE accurate and more stable" than scraping the HTML, which is the whole
reason it exists. But the fetch rung accepts only:

```
/text\/html|application\/xhtml|text\/plain/i     src/lanes/own/index.ts:271
```

`text/calendar` is refused as `reason: 'empty'`. So the package will happily
tell a caller "here is the ICS feed for this site" and then be unable to fetch
it. The most accurate data source we can find is the one we cannot read.

Same gap for `text/csv` (Fallow has `lib/ingestion/csv-parser.ts`, an RFC4180
parser with quoted-comma and embedded-newline handling) and for JSON feeds.

**Spec.** Widen accepted content-types and return the body as a typed payload
rather than forcing everything through HTML parsing:

- add `text/calendar`, `text/csv`, `application/json`, `application/rss+xml`,
  `application/atom+xml`
- add `CrawlPage.contentKind: 'html' | 'calendar' | 'csv' | 'json' | 'feed'`
- parsing ICS into events stays with the CALLER (domain logic), but the raw
  decoded body must reach them — today it does not
- the injection guard still runs: a feed is untrusted text like any other

**Watch out:** widening content-types must not widen what the SSRF and
same-site guards allow. This is a body-handling change only.

---

## CRAWL-VISION-1 — pages whose content is a single image

Municipal and venue pages routinely publish the real detail — dates, lineup,
time, address, parking — inside one poster/flyer image, with almost nothing in
the page text. Fallow documents the canonical case (Perinton "Center Stage
Concert Series") in `lib/ingestion/page-image-flyer.ts`.

Today oliver-crawl parses such a page, finds no meaningful text, runs the whole
free ladder, and returns `unreachable`. The content was there the entire time.

**Spec.** Split it along the same line as every other lane boundary:

- **ours (free, generic):** identify the likely content image(s) on a page —
  largest in the content region, not in nav/header/footer, not a logo/sprite/
  icon, plausible poster aspect ratio. Return them as
  `CrawlPage.candidateContentImages: string[]`.
- **caller's (paid):** running a vision model over those URLs. Fallow's
  `vision-extraction.ts` does this with an ordered model list and per-model
  usage logging; that is its business, not the package's.

Shipping only the free half is the right first step and is genuinely useful on
its own — a caller can then decide whether an image is worth paying to read.

---

## CRAWL-CONTENTKIND-1 — extraction version stamping

Fallow has `lib/ingestion/extraction-version.ts`. oliver-crawl can *replay* a
stored recipe (`applyRecipe`) but stamps nothing on its output, so a consumer
holding a stored page has no way to answer "was this extracted by an older,
worse version — should I re-run it?"

Without this, improving the extractor has no mechanism to reprocess everything
it would now do better. The improvement only ever applies to pages crawled
after it shipped.

**Spec.** Add `CrawlPage.extractorVersion: string`, bumped on any change to
text/link/JSON-LD extraction, and document the re-crawl contract: a consumer
compares stored version against `EXTRACTOR_VERSION` and re-processes what is
behind. Cheap to add, and impossible to add retroactively with any value.

---

## CRAWL-CONCURRENCY-1 — cross-host parallelism

`crawlSite` is strictly sequential. Correct for politeness *within* one host,
but crawling 50 unrelated hosts serially is 50× slower than it needs to be for
no benefit to anyone.

`core/host-throttle.ts` already enforces per-host pacing process-wide and
across concurrent callers (it reserves the slot before awaiting, specifically
so concurrent callers serialise). So the per-host safety property that makes
this risky is **already solved** — this is mostly wiring.

**Spec.** `crawlSite(..., { concurrency: n })`, default 1 so nothing changes
silently. Never parallelise within a host; the throttle would serialise it
anyway, so the only effect would be to hold connections open. Cap by distinct
host, not by URL.

---

## CRAWL-SESSION-1 — no session continuity for credentialed crawls

A caller can pass `headers` (including a Cookie), and those are correctly sent
only to the target's own host. But there is no cookie jar: a login that sets a
session cookie on the first response cannot carry it to page two.

That makes multi-page members-area crawling impossible even though single-page
credentialed crawling works — a sharp edge that is currently undocumented.

**Spec.** Either implement a per-crawl (never global) cookie jar scoped to the
target host, or document the limitation explicitly in EXISTING-PROJECTS.md.
Documenting is the honest short-term answer and costs nothing.

**Watch out:** a cookie jar is a credential store. It must never outlive one
crawl, never be shared between targets, and never follow a redirect off-host.

---

## CRAWL-DETAILLINK-1 — choosing which link to follow for a missing field

Fallow's `lib/ingestion/detail-link-picker.ts` answers "which of this page's
links plausibly carries a still-null field" from `{label, url}` pairs. The
mechanism is generic; only its keyword table is domain-specific.

`PageLink` here already carries `{ url, text }`, so the input exists.

**Spec.** A generic scorer taking caller-supplied keyword groups and returning
ranked candidates. Ships the mechanism, keeps the domain vocabulary with the
caller — the same split used everywhere else in this package.

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

## CRAWL-UA-1 — no contact URL in the user agent goes unflagged

`userAgent` is required but unvalidated. A UA with no contact URL is a
significant cause of being blocked — a site operator seeing unexplained traffic
has no way to reach you, so they block. Fallow derives its UA from
`FALLOW_APP_ORIGIN` for exactly this reason (`lib/ingestion/user-agent.ts`,
WHITE-LABEL-1).

**Spec.** Warn once (never throw) when `userAgent` contains no `http(s)://` or
`+`-prefixed contact. Document the convention in ADOPTION.md. Deliberately not
an error: a caller may have a legitimate reason, and breaking their crawl over
a style rule would be worse than the problem.

---

## CRAWL-DEGRADE-1 — no notion of a source degrading over time

The package reports per-crawl outcomes. It has no concept of "this source has
failed six runs in a row and needs attention." Fallow builds that on top
(`source-autofix.ts`, `source-recover.ts`, `refresh-failure.ts`).

Most of that is rightly the consumer's — it needs a database. But the package
currently gives a consumer no *shape* to build against, so every consumer
re-invents failure classification from raw `reason` strings.

**Spec.** Classify failures as `transient` (timeout, 5xx, DNS blip) vs
`structural` (404, robots disallow, dead host) on the result. That single bit
is what a consumer needs to decide "retry" vs "tell a human", and only the
package has the context to judge it correctly.

---

## Live tracker

| Date | Entry | Change |
|---|---|---|
| 2026-07-27 | file created | Nine specs opened from the post-extraction audit against Fallow. None implemented. |
| 2026-07-27 | PARITY-HEADERS-1 + PARITY-READABILITY-1 | SHIPPED, specs removed per policy. Headers: accept-language + richer accept on the direct-fetch rung; accept-encoding left runtime-owned on purpose. Readability: paragraphs-vote-for-parent scoring as the no-semantic-tag fallback, 40% mass guardrail, ablation-verified. v0.2.0 tagged; update flow documented in EXISTING-PROJECTS.md. |
| 2026-07-27 | VENDOR-POLICY-1 | SHIPPED same day as found: crawl() now runs eligibility+robots+same-site lane-independently; vendor-only crawls were previously entirely unvetted. Ablation-verified (4 tests red without gate). |
| 2026-07-27 | cleanup | DELETED buildQuarantineTask + tests (remove-don't-archive): Fallow's curation-task shape, zero consumers here, belongs in Fallow at wiring time. |
| 2026-07-27 | external-tools honesty | Firecrawl/ScrapeGraphAI/Crawlee audited at API/architecture level, NOT full source. Their free techniques we lack are now specs: PARITY-READABILITY-1, PARITY-HEADERS-1, CRAWL-RESUME-1. |
| 2026-07-27 | shipped | Crawl-delay honoured (ROBOTS-DELAY-1) + WHITE-LABEL-2 FallowBot strings removed from output. Structured-data signal shipped (JSONLD-SIGNAL-1). |
| 2026-07-27 | beat-the-vendors | Four specs opened for things a stateless per-call API structurally cannot do: BETTER-LASTMOD-1, BETTER-RUNGMEMORY-1, BETTER-DIFF-1, BETTER-SOFT404-1. |
| 2026-07-27 | vendor parity | Reframed around displacing the paid APIs, not just matching Fallow. Markdown + onlyMainContent SHIPPED. PARITY-MAP-1 and PARITY-ACTIONS-1 opened. Recorded that proxies/stealth and general web search are genuinely not free-achievable. |
