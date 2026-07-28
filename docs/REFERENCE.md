# Reference

Full option-by-option detail. Start with the [README](../README.md) if you just want to use the thing.

---

Governed web crawling for TypeScript. Two independent lanes: **our own crawler** (no API keys, no cost) and an optional **vendor lane** (Firecrawl, Apify). Use either. Use both. The free one is the default.

Most scraping libraries give you "URL in, text out". This one also answers *should we have fetched that at all* — SSRF and DNS-rebinding guards, same-site enforcement, robots posture, and prompt-injection sanitising applied **before** page content ever reaches an LLM.

---

## Why two paths

| | Free path: `own` | Paid path: `vendor` |
|---|---|---|
| **Cost** | Free | Per call, billed by the vendor |
| **Keys needed** | None | One per vendor |
| **Runs on** | Your infrastructure | Theirs |
| **Handles** | HTML, JSON-LD, SPA payloads, conditional GET | JS-heavy pages, hard bot walls |
| **Default?** | Yes | No — opt in explicitly |

The free path handles the large majority of real pages. The paid path covers what it genuinely cannot reach: an origin behind a commercial anti-bot service, where the differentiator is a residential proxy pool that cannot be replicated for free.

**Nothing bills unless a call asks it to.** `lanes` defaults to `['own']`, and a missing vendor key disables that rung alone rather than failing the crawl.

---

## Install

```bash
npm install github:oliver-chase/oliver-crawl
```

## Use

```ts
import { createCrawler, configFromEnv } from '@oliver/crawl-core';

const crawler = createCrawler(configFromEnv({ userAgent: 'MyBot/1.0 (+https://mysite.com/bot)' }));

const result = await crawler.crawl(
  { baseUrl: 'https://example.com', robotsPolicy: 'allow' },
  'https://example.com/catalog',
);

if (result.ok && !result.notModified) {
  const page = result.pages[0]!;
  page.text;      // sanitised, length-capped visible text — safe to send to an LLM
  page.jsonLd;    // structured data, free and deterministic — no LLM needed
  page.links;     // same-site links, for pagination or detail pages
  page.httpEtag;  // pass back next time to get a free 304
}
```

Failure is a **value, not an exception**:

```ts
if (!result.ok) {
  result.reason;  // 'blocked' | 'unreachable' | 'empty' | 'quarantined' | 'no_lane_available'
  result.detail;  // human-readable explanation
}
```

### Both lanes

```ts
const result = await crawler.crawl(target, url, { lanes: ['own', 'vendor'] });
```

Tries free first; escalates to a paid vendor only if the free lane can't reach the page. A **policy** refusal (off-domain, quarantined) never escalates — paying to route around your own guard is not a fallback.

### Crawling a whole site

```ts
import { createCrawler, crawlSite } from '@oliver/crawl-core';

const run = await crawlSite(crawler, target, {
  seeds: ['https://example.com/catalog'],
  followPagination: true,
  maxPages: 5,
});

run.pages;        // everything fetched and parsed
run.notModified;  // URLs that answered 304 — unchanged, and NOT failures
run.failures;     // per-URL, so one bad page never sinks the run
run.truncated;    // true if it stopped at maxPages rather than running out
```

Sequential by design (one request at a time): hammering a small site in parallel is what gets a crawler blocked. Already-visited URLs are never re-fetched, so a "next page" link that loops back to page 1 terminates instead of spinning.

### Cheap re-crawls (the point of scheduled crawling)

Two mechanisms, because origins differ:

- **Origin sends ETag/Last-Modified** → conditional GET → **304, nothing fetched at all**, reported under `notModified`.
- **Origin sends nothing** (most small sites) → the **content-region hash** (nav/footer-insensitive) is compared → the page is fetched, but `unchanged` tells you the real content is identical so extraction/LLM can be skipped.

Both use the same loop: store `result.validators`, pass them back as `priorValidators`. A site checked hourly that changes weekly then costs one real fetch a week and 167 free 304s. Wire it with `onSignals` (push) or the return value (pull) — see [ADOPTION.md](ADOPTION.md).

### Site-wide change detection in one request

A sitemap's `<lastmod>` tells you which pages moved without fetching any of
them. Conditional GET answers the same question one request per page:

```ts
const run = await crawlSite(crawler, target, {
  useSitemap: true,
  priorLastmod: stored.lastmod,   // from last run
});

run.lastmod;           // { [url]: lastmod } — store for next time
run.skippedByLastmod;  // never fetched at all
```

Used only to **skip**. `<lastmod>` is origin-supplied and frequently a lie —
plenty of CMSs stamp every URL with today's date — so a *changed* value proves
nothing and simply lets the page through to the normal 304 and content-hash
checks, which are trustworthy. A page publishing no `<lastmod>` is always
crawled. Omit `priorLastmod` to disable entirely.

### Pages that need a click first

Some listings render their content only after a "Load more" button or an
infinite scroll. The first render is technically correct and practically
empty.

```ts
createCrawler({
  localRender: true,
  browserActions: [
    { type: 'click', selector: '.load-more' },
    { type: 'scroll', times: 3 },
    { type: 'wait', ms: 500 },
  ],
});
```

Runs on the local-render rung only. The bounds are library constants, not
options: at most 10 actions, 20 seconds total, 5 seconds per wait. A step that
fails is skipped rather than fatal, because a missing "Load more" usually means
everything already loaded. The page's origin is re-checked after every step and
the run stops if it navigated away — a click can navigate, and continuing to
script a page that was never vetted would be a request forgery with a real
browser behind it.

**Never build these from crawled content.** An action derived from a page you
fetched lets that page script the browser that fetched it.

### Resuming a killed crawl

`crawlSite` keeps its queue in memory, so a 500-page run killed at page 400
restarts from zero unless you save its progress. The package stores nothing —
it hands you a snapshot and takes one back:

```ts
const run = await crawlSite(crawler, target, {
  followLinks: true,
  onProgress: (state) => myStore.save(target.id, state),  // plain JSON
});

// later, in a new process
await crawlSite(crawler, target, { followLinks: true, resumeFrom: myStore.load(target.id) });
```

The snapshot is emitted after each page is marked done *and* after the links
it discovered are queued, so it is always a coherent "everything up to here is
finished" — never one that would re-fetch the page just handled or lose its
links. Failures snapshot too: a terminally failed page is finished with, and
retrying it on resume would just repeat the failure.

`resumeFrom` replaces the seeds entirely. Pages are **not** carried over — you
already persisted those when you received them. This resumes the work, not the
results.

## Searching within a site (free)

`crawler.search()` asks a search engine, which always costs money. When you
already know the site and want its relevant pages, ask the site instead:

```ts
import { searchSite } from '@oliver/crawl-core';

const found = await searchSite(crawler, target, 'annual report');
found.urls;     // same-site result URLs
found.pattern;  // which query shape worked — pass back as knownPattern to skip probing
```

Free, and uncontroversial: submitting a query to a site's published search form
is ordinary use of a feature, not working around one. It also reaches pages
neither link-following nor a sitemap will — an archived page reachable only
through search is exactly the kind a large site buries.

Results are read from the **main content region**, not the whole page, so the
site's navigation does not come back as hits. Asset links are excluded.

It probes a handful of query shapes (`/?s=`, `/search?q=`, and a few others)
and reports which one worked. Many sites have no usable search; that returns
`ok: false` with a reason rather than throwing. This does **not** replace web
search — it cannot tell you which sites exist.

### Mapping a site without crawling it

`crawlSite` with `followLinks` has to FETCH every page to find the next one.
When you only need to know what exists, that is minutes and hundreds of
requests for something the site mostly already publishes:

```ts
import { mapSite } from '@oliver/crawl-core';

const map = await mapSite(crawler, target, { maxUrls: 500 });

map.feeds;    // ICS/RSS/Atom — usually the best targets on any site
map.urls;     // everything found
map.sources;  // { sitemap, feeds, homepageLinks } — why the result looks how it does
```

Exactly **one page body** is fetched: the homepage. Everything else comes from
listing documents. Cheap enough to run *before* deciding what a real crawl
should target, which makes `maxPages` a budget you spend deliberately instead
of one the queue order spends for you.

It is not a crawl — no recursion, no page content. Feed `map.urls` to
`crawlSite` as `seeds` when you want the content. A missing sitemap or an
unreachable homepage degrades to whichever source did answer, rather than
returning nothing.

### Discovering what to crawl (free)

```ts
// Simplest: let crawlSite find the pages itself.
const run = await crawlSite(crawler, target, { useSitemap: true, maxPages: 50 });

// Or discover explicitly:
const seeds = await crawler.discoverSeeds(target, 100);
```

Reads `/sitemap.xml` (following index files one level), filtered to same-site https URLs — a sitemap is origin-controlled content and gets no more trust than a page's own links. No sitemap falls back to `baseUrl`.

### Letting the crawler govern itself

```ts
const crawler = createCrawler({ userAgent: 'MyBot/1.0', autoRobots: true });
```

Without this, the crawler trusts the `robotsPolicy` you set on each target (and fails closed on `'unknown'`). With it, an unknown posture is resolved by actually fetching and parsing robots.txt — **cached per host**, so it costs one request per host, not per page. An explicit posture you set is never overridden.

### Non-HTML documents (feeds, calendars, CSV, JSON)

The own lane reads more than HTML. `page.contentKind` tells you what you got:

| `contentKind` | From | `markdown` / `links` / `jsonLd` |
|---|---|---|
| `html` | text/html, xhtml | populated |
| `calendar` | text/calendar (`.ics`) | empty |
| `csv` | text/csv | empty |
| `json` | application/json, `+json` | empty |
| `feed` | RSS, Atom, generic XML | empty |
| `text` | text/plain | empty |

Non-HTML kinds arrive verbatim in `page.text`. **Parsing them is yours** —
the shape a feed or CSV should become is defined by your schema. Branch on
`contentKind` rather than sniffing `contentType`, which varies by server.

This matters because [feed discovery](#discovering-what-to-crawl-free) hunts
for ICS feeds precisely because they are more accurate and more stable than
scraping a page. Now the feed it finds can actually be fetched.

Images, video, PDFs and binaries are still refused (`reason: 'empty'`) —
HTML-parsing a JPEG produces confident nonsense. The injection guard runs on
every kind: a calendar feed is untrusted remote text like any page.

Only `text` and `textSha256` are meaningful on non-HTML kinds; `markdown` and
`contentRegionSha256` are empty rather than faked, so a rung or kind change
can never look like a content change.

## Deciding what to do next

Three fields exist so you don't have to re-derive them from prose:

```ts
if (!result.ok) {
  result.failureClass;  // 'transient' | 'structural'
}

page.likelyEmptyState;  // page loaded but appears to say nothing
page.extractorVersion;  // which version of extraction produced this
```

**`failureClass`** answers "is retrying worth it?". `transient` means the
world might differ next time — DNS blips, timeouts, 5xx, and bot walls.
`structural` means retrying changes nothing until something is fixed — a 404,
a robots disallow, an inactive target, an unsupported content-type. Count
consecutive `structural` failures per source to retire a dead one
automatically; counting `transient` ones tells you only that the internet is
the internet. Note a **403 is transient**: it is a bot wall far more often
than a permanent refusal, and treating it as structural would retire sources
that work on the next run.

**`likelyEmptyState`** flags pages that loaded successfully and say nothing —
"no results", "coming soon", parked domains, soft-404s. These return HTTP 200
and cost a full model call to learn nothing.

It is advisory and the page is still returned in full, because an empty state
is often a true fact worth recording. A supplier listing with no stock this
month genuinely has no stock this month; that is data, not an error.

**`extractorVersion`** lets an extraction improvement reach pages you already
stored. Keep it beside the page; when it falls behind `EXTRACTOR_VERSION`,
re-process. It cannot be added retroactively with any value.

## Feeding an LLM: use `markdown`, not `text`

`page.markdown` is the main content region as Markdown — headings, lists,
tables and links preserved, nav/header/footer/sidebar removed. `page.text` is
the flat visible text of the whole page, kept for compatibility.

Prefer `markdown`. A schedule table in `text` is an unlabelled token soup, and
an extractor has to guess which token is a date and which row it belonged to;
in `markdown` the columns still carry their meaning. Both fields go through the
prompt-injection guard.

`markdown` is an empty string on text-only rungs (Jina, vendor) where there is
no HTML to convert — those rungs already deliver prose in `text`. Fall back to
`text` when it is empty.

## Complete API surface

Everything the package exports, grouped by what you would reach for it to do.
Anything not listed here is not exported.

### Crawling

| Export | Purpose |
|---|---|
| `createCrawler(config)` | The crawler. Everything else takes one. |
| `crawlSite(crawler, target, options)` | Multi-page crawl: seeds, discovery, budgets, resume |
| `mapSite(crawler, target, options)` | URLs a site has, without crawling them |
| `searchSite(crawler, target, query)` | Search **within** a site using its own search — free |
| `searchAndCrawl(crawler, query, options)` | Web search, then read the results |
| `searchWeb(query, config, options)` | Web search only (paid) |

### Reading a result

| Export | Purpose |
|---|---|
| `summarizeStructuredData(jsonLd)` | Is any of this JSON-LD about the page's content? |
| `diffContent(previous, current)` | What changed between two versions — re-extract the delta, not the page |
| `findContentImages($, pageUrl)` | Images that plausibly carry the content (flyers, posters) |
| `pickDetailLinks(links, keywords)` | Which link probably answers a still-missing field |
| `extractJsonLdEvent` · `extractAllJsonLdEvents` · `extractJsonLdAddress` · `formatJsonLdAddress` | schema.org readers |
| `classifyFailure(reason, detail)` | `transient` (retry) vs `structural` (needs a fix) |
| `looksLikeEmptyState(text)` | "No results" pages that cost a model call to learn nothing |
| `looksLikeBlockPage(text)` | A bot-wall interstitial wearing an HTTP 200 |
| `EXTRACTOR_VERSION` | Bump signal: re-process pages stored by an older extractor |

### Change detection

| Export | Purpose |
|---|---|
| `computeContentRegionHash(html)` | Structural hash, nav/footer-insensitive |
| `probeCheapChangeSignal` · `cheapSignalsMatch` | Cheap pre-fetch change probe |
| `urlDedupKey(url)` · `sameUrlResource(a, b)` | Canonical URL identity |

### Discovery

| Export | Purpose |
|---|---|
| `discoverSitemapUrls(target, options)` | Sitemap entries, with `lastmod` |
| `discoverIcsFeed` · `candidateIcsUrls` · `googleCalendarIcsCandidates` · `parseFeedLinksFromHtml` | Calendar and feed discovery |
| `findNextPageUrl` · `discoverPaginatedUrls` | Pagination |

### Fetch rungs

| Export | Purpose |
|---|---|
| `renderViaLocalChromium(url, enabled, actions)` | Local browser render, with optional `browserActions` |
| `renderViaService` · `renderServiceFrom` | Your own render service |
| `fetchViaWayback(url, options)` | Internet Archive capture — free, gated (see [LANES](LANES.md)) |
| `extractPdfText(bytes)` | PDF text layer, via the optional `unpdf` peer |
| `classifyContentType` · `refineKindByUrl` | What kind of document is this |
| `safeFetch` | Fetch with the host guards applied |

### Policy and safety

| Export | Purpose |
|---|---|
| `sanitizeCrawledText` · `detectPromptInjectionSignals` | The injection guard |
| `evaluateRobotsForUrl` · `parseRobots` · `userAgentToken` | robots.txt |
| `assertTargetEligible` · `assertRequestUrlAllowed` · `assertRedirectUrlAllowed` · `assertRedirectUrlAllowedForHost` | Same-site and eligibility |
| `assertHostResolvesToPublicAddress` · `assertPublicHost` · `isSafeHttpUrl` | SSRF screening |
| `createDohLookup` · `DEFAULT_DOH_ENDPOINT` | DNS-over-HTTPS, for runtimes without `node:dns` |
| `publishedCrawlDelayMs(host)` · `MAX_HONORED_CRAWL_DELAY_MS` | The site's own `Crawl-delay` |

### Configuration and state

| Export | Purpose |
|---|---|
| `configFromEnv(overrides)` · `resolveConfig(config)` | Config helpers |
| `createRungMemory` · `recallWinningRung` · `rememberWinningRung` · `forgetWinningRung` · `RUNG_MEMORY_TTL_MS` | Per-host rung memory |
| `applyRecipe` · `parseStoredRecipe` · `MAX_RECIPE_FAILURES` | Replay a stored extraction recipe |
| `availableVendorRungs` · `availableSearchProviders` | Which paid rungs your keys enable |
| `DEFAULT_*` constants | Defaults, for callers who want to reason about them |

### Options worth knowing

| Config | Effect |
|---|---|
| `autoRobots` | Resolve an unknown robots posture by fetching robots.txt. **Required** for `crawlSite` on targets with no stored `robotsPolicy`, which otherwise fail closed |
| `localRender` | Free local Chromium rung |
| `browserActions` | Click/scroll/wait before capture, on the local render rung |
| `jinaEndpoint` | Point the reader rung at your own Apache-2.0 deployment instead of the public one |
| `renderWhenTextBelow` | Escalate to render when a page parsed but is implausibly short — a JS page shipping only nav and footer otherwise reads as a success |
| `useArchiveFallback` · `archiveMaxAgeDays` | Internet Archive rung — off by default, `allow` posture only |
| `rungMemory` | Remember which rung works per host (default on) |
| `cacheTtlMs` · `minHostIntervalMs` · `adaptiveThrottleMultiplier` | Repeat-request and politeness controls |

## Search

Query in, URLs out — a different surface from crawling, and always paid.

```ts
const found = await crawler.search('industrial flow meter suppliers', { maxResults: 5 });

if (found.ok) {
  found.results;   // [{ title, snippet, url, injectionFiltered? }]
  found.provider;  // which one answered
} else {
  found.reason;    // 'no_provider_configured' | 'no_results' | 'budget_refused' | 'error'
}
```

A search provider is untrusted on both counts, so results are filtered before you see them:

- **`url`** — anything that is not a safe public `http(s)` URL is dropped. A `javascript:` href would be an XSS in your UI; a private-network URL would be an SSRF in your fetcher.
- **`title` / `snippet`** — run through the same prompt-injection guard as crawled page text. A snippet is usually the target page's own meta description, so it is attacker-influenceable prose, and these strings are the ones people feed to a model. When the guard trips, both fields come back empty with **`injectionFiltered: true`**, and the `url` is still returned — it is validated separately and still worth crawling.

Check `injectionFiltered` if you display snippets; an empty snippet on a real URL is otherwise puzzling, and the flag is itself a useful signal about the page behind it.

Returns an outcome rather than a bare array on purpose: an empty array cannot tell you whether the web had nothing, your key was missing, or your budget said no. Serper is tried before Tavily by default (roughly 5x cheaper per call for the same job). Provider results are filtered through the same URL-safety check as extracted links, so a `javascript:` or private-host result never reaches you.

### Conditional GET — the cheapest crawl is the one that doesn't happen

```ts
const result = await crawler.crawl(target, url, { etag: stored.etag, lastModified: stored.lastModified });
if (result.ok && result.notModified) return; // page unchanged, nothing fetched, nothing parsed
```

---

## Configuration

Explicit, or from the environment. Both work; explicit wins.

```ts
createCrawler({
  userAgent: 'MyBot/1.0 (+https://mysite.com/bot)',   // please set this
  vendor: { firecrawl: process.env.FIRECRAWL_API_KEY },
  onUsage: (event) => metrics.record(event),           // per-call cost/latency
  checkBudget: () => spendToday < dailyCap,            // vetoes paid calls
  dnsLookup: myResolver,                               // optional
});
```

### From `.env` / `.env.local`

`configFromEnv()` reads these. All optional:

```bash
OLIVER_CRAWL_USER_AGENT="MyBot/1.0 (+https://mysite.com/bot)"

# Vendor lane — each enables exactly one rung
OLIVER_CRAWL_FIRECRAWL_KEY=...   # or FIRECRAWL_API_KEY
OLIVER_CRAWL_APIFY_TOKEN=...     # or APIFY_API_TOKEN

OLIVER_CRAWL_VENDOR_ORDER=firecrawl,apify

# Search providers (their own surface, separate from the scrape rungs)
OLIVER_CRAWL_TAVILY_KEY=...      # or TAVILY_API_KEY
OLIVER_CRAWL_SERPER_KEY=...      # or SERPER_API_KEY
OLIVER_CRAWL_SEARCH_ORDER=serper,tavily
```

The bare vendor names (`FIRECRAWL_API_KEY`) are accepted as fallbacks, so adopting this package doesn't mean renaming env vars that already work.

```ts
crawler.vendorRungs(); // ['firecrawl'] — what's actually usable right now
```

---

## Design rules

These are why it's reusable across projects rather than welded to one:

1. **No database.** Nothing imports a DB client. State leaves through `onUsage` / `checkBudget` callbacks, so one consumer can write Postgres, another a spreadsheet, another nothing.
2. **No env reads in core.** Config is passed explicitly; `configFromEnv()` is opt-in convenience. You can hold two differently-configured crawlers in one process.
3. **Fail soft across the boundary.** Ordinary failure returns a result. Only programmer error throws.
4. **Every rung optional.** No key means that rung is skipped, never an error.
5. **The guard runs before you see the text.** `page.text` has already been through prompt-injection sanitising.

---

## What the own lane actually does

1. **Policy** — eligibility, robots posture, same-site, SSRF/DNS-rebinding. Refusals cost no network call.
2. **Conditional GET** — sends `If-None-Match`/`If-Modified-Since` from stored validators; a 304 ends the crawl for free.
3. **Fetch** — real UA; redirects followed manually and **re-validated per hop** (a redirect is attacker-controlled input); body capped at 2 MB.
4. **Parse** — visible text, title, JSON-LD, same-site links, outbound hosts; SPA recovery from inline script payloads when the served HTML is a JS shell.
5. **Guard** — prompt-injection sanitising before anything is returned.
6. **Hash** — full-body *and* content-region digests, so a nav/footer tweak doesn't read as a content change.
7. **Local render** — free local headless Chromium (`localRender: true` + `npx playwright install chromium`) for JS-only pages.
8. **Remote render** — your own render service (`browserRender`), for deployments that can't run a browser.
9. **Jina Reader** — free, keyless last resort for bot-walled or JS-only pages.

Rungs 1-7 need no credentials and cost nothing. See [LANES.md](LANES.md).

### The SSRF guard

Checking a URL's literal hostname is not enough. An attacker who controls DNS for a host they own can point `totally-normal.example.com` at `127.0.0.1` or `169.254.169.254` (cloud instance metadata). So:

- resolution is checked, not just the hostname
- **every** returned record is checked — a rebinding attack needs only one internal answer in a multi-record reply
- results are cached on **success only**, so a transient resolver failure can't blacklist a real host
- private, loopback, link-local, CGNAT, benchmarking and multicast ranges all refused
- bare-integer hosts (`2130706433` == `127.0.0.1`) refused rather than decoded

Covered by the host-policy suite — see the [README](../README.md#status) for current counts.

---

## Development

```bash
npm install
npm run check     # typecheck + tests
npm run build     # emit dist/
```

## Status

Feature-complete and hardened: typecheck clean (strict, `noUncheckedIndexedAccess`), builds to dist, verified against live sites AND as a real git-installed dependency. Test and live-check counts live in the [README's Status section](../README.md#status). Both lanes, the free-first rung ladder (fetch → local Chromium → your render service → Jina), self-governing robots, sitemap/feed/pagination discovery, JSON-LD, two independent re-crawl-cheapening mechanisms, recipe replay, the multi-page orchestrator, and web search. See [ADOPTION.md](ADOPTION.md) to use it in a repo, [LANES.md](LANES.md) for the lane model.

## License

MIT

---

**See also:** [DECISIONS](DECISIONS.md) — why the code is the way it is · [README](../README.md) · [ADOPTION](ADOPTION.md) · [LANES](LANES.md) · [ARCHITECTURE](ARCHITECTURE.md) · [BACKLOG](BACKLOG.md) — known gaps
