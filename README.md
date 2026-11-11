# oliver-crawl

`oliver-crawl` is a TypeScript library for crawling websites repeatedly, safely and cheaply. It returns the useful page content as Markdown, refuses unsafe destinations, and detects unchanged pages before they trigger expensive downstream processing.

Downloading HTML is easy. The problems start when a crawl runs every hour.

**Safety.** A crawler requests whatever URL it is given, and that URL may come from a user submission, a search result or a redirect. If someone points it at `169.254.169.254`, the address that serves instance metadata on most cloud providers, the crawler could retrieve credentials and return them as page content. `oliver-crawl` resolves every hostname and checks the addresses against private ranges before every request and again after every redirect.

**Cost.** In a pipeline that sends crawled content to a language model, fetching the page is cheap and processing it is not. A site checked hourly but changed weekly triggers roughly 160 unnecessary extractions for each one it needs. `oliver-crawl` checks whether a page changed before expensive processing happens, using the cheapest signal available, sometimes with no page request at all.

## Install

```bash
npm install github:oliver-chase/oliver-crawl#v0.18.0
```

Pin a tag and leave off the `^`. The package needs Node 20 or later, is ESM-only, and builds on install. Edge and serverless runtimes work, without local browser rendering.

## First crawl

```typescript
import { createCrawler } from '@oliver/crawl-core';

const crawler = createCrawler({
  userAgent: 'MyBot/1.0 (+https://mysite.example/bot)',
});

const result = await crawler.crawl(
  { baseUrl: 'https://example.com', robotsPolicy: 'allow' },
  'https://example.com/',
);

if (result.ok && !result.notModified) {
  console.log(result.pages[0].markdown);
}
```

Three details in that snippet matter:

- `userAgent` should carry a contact URL. A site operator who sees unexplained traffic blocks it, and the library warns once if the string has no contact
- `robotsPolicy` is your decision about the target. Leave it out or set `'unknown'` and the crawl refuses to run, which is the safe default. Set `autoRobots: true` on the crawler to have it fetch and evaluate robots.txt itself, cached per host
- `result.notModified` is true when you passed a stored `etag` and the server answered 304

No API key, account or configuration file is needed. Pages are fetched from your own machine, so the default path costs bandwidth only.

## How a page is fetched

Most pages answer a normal request, so the crawler starts there and moves to more capable methods only when needed:

1. **Request the page.** A plain HTTP GET works for most of the web
2. **Render it in a browser.** Some sites return a shell whose content appears after JavaScript runs. With `localRender: true` the page renders in local Chromium. Install it once with `npm install playwright` and `npx playwright install chromium`
3. **Retry through your own proxy.** Set `proxyFetch` to a `fetch` that routes through a proxy you run, and a blocked page is retried there before any third party sees it. A target that carries credentials never uses it
4. **Retry through Jina Reader.** Jina requests the page from its own servers and returns text, which gets past sites that reject automated clients. It is a third-party service, and it never sees a target that carries credentials
5. **Call a paid API.** Firecrawl and Apify handle sites that defeat the earlier methods
6. **Read the archived copy.** The Internet Archive may hold a copy when every live method fails

Steps 1 to 3 run on your machine or your own proxy. Step 4 uses a free public service. Paid APIs are opt-in with `lanes: ['own', 'vendor']`, and an API key alone never triggers a paid request. The archive step is off by default (`useArchiveFallback: true`) and runs only for a target whose robots posture is explicitly `allow`.

The cheaper methods go first because a `403` usually means the site spotted automated traffic, and a local browser clears many of those blocks without an external cost. The crawler also remembers for 30 minutes which method worked for each host, so the next request starts there. [LANES](docs/LANES.md) lists every rung in order.

## What comes back

A crawl returns structured page objects:

- `markdown` is the main content with its structure preserved. Give models this field
- `text` is every visible word, including navigation and cookie banners
- `contentKind` is `html`, `calendar`, `csv`, `json`, `feed`, `text` or `pdf`
- `jsonLd` and `structuredData` hold the structured data the page publishes
- `links` holds same-site links for pagination and detail pages
- `httpEtag` is the validator to send on the next run
- `extractorVersion` is the version of the extraction logic that produced the page

`markdown` is empty when a text-only method such as Jina or a vendor API served the page, because those return prose without HTML. Use `text` in that case. Store `extractorVersion` with each page and reprocess stored pages when it falls behind the exported `EXTRACTOR_VERSION`.

A pricing table flattened into text reads `Starter 5 seats $29 Pro 25 seats $99`, and the reader has to guess which numbers belong together. Markdown keeps the table, headings and lists that say how the pieces relate.

## When a page cannot be read

A failed page returns a result and does not throw, so one failure in a batch of 50 leaves the other 49 intact.

```typescript
if (!result.ok) {
  result.reason;        // blocked, unreachable, empty, quarantined or no_lane_available
  result.failureClass;  // transient or structural
  result.detail;
  result.bodyReceived;  // true when the origin answered with a body that held no content
  result.retryAfterMs;  // set when the origin sent Retry-After
}
```

`transient` failures (timeouts, DNS failures, 5xx responses, bot walls) are worth retrying later. `structural` failures (404s, robots exclusions, disabled targets) repeat until something changes, so consecutive structural failures identify a source to retire.

## Design decisions

**Every hostname is checked before fetching.** A domain can point anywhere, including `127.0.0.1` or a cloud metadata address. The crawler resolves the hostname, checks every address DNS returns, and repeats the check after each redirect. Resolution uses DNS-over-HTTPS by default on every runtime, and the `dnsLookup` option swaps in your own resolver, which a name only your network resolves requires. The exported `isSafeHttpUrl` applies the same rules to URLs you hand to another component.

**Every page is checked for prompt injection.** Web pages can carry instructions aimed at the model that reads them. Every page is filtered before it is returned, including pages from paid APIs and data files such as calendar feeds. A page that trips the filter returns `reason: 'quarantined'` with `result.quarantine`, which holds the signals, the title and the sanitized text, so your system can open a review task.

**The library says when a model is unnecessary.** Many pages publish structured data that is free, exact and needs no model:

```typescript
if (page.structuredData.hasContentData) {
  useJsonLd(page.jsonLd);
} else {
  await extractWithModel(page.markdown);
}
```

A site may publish `WebSite`, `Organization` and `BreadcrumbList` on every page, so checking that `jsonLd` exists is not enough. `hasContentData` looks for content types such as `Product`, `Article`, `Recipe`, `Event` and `JobPosting`.

**Unchanged pages are detected before expensive processing.** Three signals run from cheapest to dearest. The sitemap `lastmod` skips a page without requesting it. HTTP validators let the server answer `304 Not Modified`. A content comparison skips downstream work for a page that downloaded but did not change.

```typescript
const run = await crawlSite(crawler, target, {
  useSitemap: true,
  priorLastmod: saved.lastmod,
  priorValidators: saved.validators,
});
// run.skippedByLastmod, run.notModified, run.unchanged
// Store run.validators and run.lastmod for the next run
```

A site that changes weekly and is checked hourly settles at about one real fetch and one extraction per week. The library does not persist anything, so you store `run.validators` and `run.lastmod` and pass them back.

## Crawling a site

`crawlSite` handles several pages and you decide how far it goes.

```typescript
import { crawlSite } from '@oliver/crawl-core';

const run = await crawlSite(
  crawler,
  { baseUrl: 'https://example.com', robotsPolicy: 'allow' },
  { followLinks: true, maxDepth: 2, maxPages: 50 },
);
```

| Option | What it reaches |
| --- | --- |
| `followLinks` | Same-site pages reachable through links, up to `maxDepth` |
| `useSitemap` | URLs listed in `/sitemap.xml` |
| `followPagination` | Pages reached through "next page" links |

With none enabled, one URL produces one page.

Crawling is polite. Requests go out one at a time per host, `Crawl-delay` and `Retry-After` are honored, and URLs that redirect to one destination or differ only by a trailing slash or tracking parameter count as one page, so a site whose navigation links every page to every other page still ends. Tune pacing with `minHostIntervalMs`, `adaptiveThrottleMultiplier` (which only slows the crawler for a slow host) and `cacheTtlMs`. For long crawls set `maxDurationMs` as well as `maxPages`, since fifty pages at 30 seconds each is a 25-minute run.

`onProgress` emits a serializable snapshot after each page, and passing it back as `resumeFrom` continues an interrupted crawl.

`mapSite` finds a site's URLs from its sitemap, declared feeds and homepage links with one read of each. `searchSite` submits a query to the site's own search form, which is free and can find pages that no link or sitemap exposes.

## Beyond HTML

The crawler fetches feeds, calendars, CSV and JSON, and `contentKind` says which arrived. These files come back in `text` exactly as the server sent them, decoded and otherwise unmodified, because the right schema belongs to your application. A site's own data source is often more accurate and stable than the page that displays it.

Images, video and other binaries are refused. PDFs are read when the optional `unpdf` package is installed (`npm install unpdf`), and without it the crawl fails with a message that names the package. When the useful content is inside an image, such as a scanned menu or poster, `page.candidateContentImages` ranks the images worth examining, and reading them takes a vision model that your application runs.

## Search

Fetching a known URL needs no provider. Finding URLs needs one, and search providers charge per query, so `crawler.search()` requires a key:

```typescript
const found = await crawler.search('industrial flow meter suppliers');

if (found.ok) {
  found.results;
  found.provider;
} else {
  found.reason; // no_provider_configured, no_results, budget_refused or error
}
```

`searchAndCrawl(crawler, query)` searches and crawls the results, returning `found.pages` and `found.skipped`. Results pass through the same hostname checks as every other URL, since a provider can return sites you have not vetted.

## Configuration

Only `userAgent` is needed, and it defaults to a generic identifier that triggers the contact warning. `configFromEnv()` reads the options below from environment variables:

```bash
OLIVER_CRAWL_USER_AGENT="MyBot/1.0 (+https://mysite.example/bot)"
OLIVER_CRAWL_LOCAL_RENDER=1
OLIVER_CRAWL_AUTO_ROBOTS=1
OLIVER_CRAWL_FIRECRAWL_KEY=...
OLIVER_CRAWL_SERPER_KEY=...
```

```typescript
import { createCrawler, configFromEnv } from '@oliver/crawl-core';

const crawler = createCrawler(
  configFromEnv({
    onUsage: (event) => myMetrics.record(event),   // every external call and its cost
    checkBudget: () => spentToday < myCap,         // consulted before every paid call
    renderWhenTextBelow: 600,
    limits: { maxBodyBytes: 5_000_000 },
  }),
);
```

- `autoRobots` is off by default, so applications that already track robots posture stay the source of truth and no unexpected request goes out per unknown target
- `headers` on a target carries credentials you already hold. They go only to that target's own host, and a redirect cannot carry a token to another origin. The library never acquires, stores or refreshes credentials
- The library keeps no database. Your application owns persistence, scheduling and the conversion of pages into your own objects

[REFERENCE](docs/REFERENCE.md) lists every option and return field.

## Documentation

| Document | Purpose |
| --- | --- |
| [ADOPTING](docs/ADOPTING.md) | Starting a new project, replacing a crawler you run, and troubleshooting |
| [REFERENCE](docs/REFERENCE.md) | Every option and return field |
| [LANES](docs/LANES.md) | The retrieval ladder, rung by rung |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Request flow, module map and design boundaries |
| [DECISIONS](docs/DECISIONS.md) | Why the code works the way it does |

Open work lives in the `oliver-crawl` GitHub Project named in `docs/backlog-config.json`.

## Development

```bash
npm run check   # type check, unit tests (extraction accuracy included), decision-record gate, comment-budget gate
npm run accuracy # scores extraction on the fixed corpus in tests/accuracy
npm run live    # exercises the library against real websites
```

The package is strict TypeScript and builds to `dist/`. Installation is also tested as a genuine Git dependency.

## License

MIT
