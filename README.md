# oliver-crawl

`oliver-crawl` is a TypeScript library for repeatedly crawling websites safely and cheaply. It returns the useful page content as Markdown, blocks unsafe destinations, and detects unchanged pages before they trigger expensive downstream processing.

Downloading HTML is easy. The problems start when a crawl runs every hour.

**The first problem is safety.** A crawler requests whatever URL it is given. That URL may come from a user submission, a search result, or a redirect. If someone points it at `169.254.169.254`, the address that serves instance metadata on most cloud providers, the crawler could retrieve credentials and return them as page content.

`oliver-crawl` resolves every hostname and checks the resulting addresses against private address ranges **before every request**. It checks again after every redirect, because a redirect can send the crawler to a new destination.

**The second problem is cost.** In a pipeline that sends crawled content to a language model, fetching the page is usually cheap. Processing that page with a model is not.

A site checked hourly but changed weekly could trigger roughly 160 unnecessary extractions for every extraction it actually needed.

`oliver-crawl` checks whether a page changed **before expensive processing happens**. It uses the cheapest signal available — sometimes with no page request at all — and skips unchanged content.

---

## Install

```bash
npm install github:oliver-chase/oliver-crawl#v0.17.0
```

Then create a crawler and crawl a page:

```typescript
import { createCrawler } from '@oliver/crawl-core';

const crawler = createCrawler({
  userAgent: 'MyBot/1.0 (+https://mysite.com/bot)'
});

const result = await crawler.crawl(
  { baseUrl: 'https://example.com', robotsPolicy: 'allow' },
  'https://example.com/catalog',
);

if (result.ok && !result.notModified) {
  console.log(result.pages[0].markdown);
}
```

No API key, account, or configuration file is required. Pages are fetched from your own machine, so the default path costs only bandwidth.

**Requirements:** Node 20 or later. The library also runs in edge and serverless environments, where local browser rendering is unavailable.

---

## How Oliver-crawl gets a page

Most pages work with a normal HTTP request, so `oliver-crawl` starts there. When that is not enough, it moves through progressively more capable retrieval methods, from free local options to paid services.

1. **Request the page.** An ordinary HTTP GET works for most of the web.
2. **Render it in a real browser.** Some sites return an HTML shell whose content only appears after JavaScript runs. A plain request gets navigation and an empty page. With `localRender: true`, Chromium renders the page locally. Install it once with `npx playwright install chromium`.
3. **Retry through Jina Reader.** Some sites reject clients that do not look like people, regardless of what the page contains. Jina requests the page from its own infrastructure and returns the text.
4. **Call a paid API.** Firecrawl and Apify provide commercial anti-bot infrastructure for sites that defeat the earlier methods.
5. **Read the archived copy.** When every live method fails, the Internet Archive may still have a copy of the page.

**Steps 1–3 run on your own machine and cost nothing beyond bandwidth.**

Paid APIs are deliberately opt-in:

```typescript
lanes: ['own', 'vendor']
```

A configured API key is not enough to trigger a paid request. A test fails the build if the paid rung is reached without explicit opt-in.

The archive fallback is also off by default:

```typescript
useArchiveFallback: true
```

When enabled, it only runs for targets whose robots posture is explicitly `allow`. It can recover a page the site was willing to serve; it does not bypass a site that refused the crawler.

### Why the order matters

A `403` often means a site has identified the request as automated traffic. A locally rendered browser can clear many of those blocks without adding an external API cost.

The crawler therefore tries the cheaper methods first. Escalating to a paid API after the first rejection would spend money on pages that a local browser could often retrieve for free.

The crawler also remembers which retrieval method eventually worked for each host for **30 minutes**. If a site consistently rejects ordinary requests, the next request starts at the successful rung instead of wasting another request on a method that already failed.

That memory expires automatically. A stale entry may cost one extra request, but it cannot permanently prevent the crawler from finding a working method.

---

## What comes back

A crawl returns structured page objects rather than raw HTML.

```typescript
const page = result.pages[0];

page.markdown
page.text
page.contentKind
page.structuredData
page.jsonLd
page.links
page.httpEtag
page.extractorVersion
```

Each field has a specific purpose:

* **`markdown`** — the main content as Markdown, with its structure preserved.
* **`text`** — every visible word, including navigation, footers, and cookie banners.
* **`contentKind`** — `html`, `calendar`, `csv`, `json`, `feed`, `text`, or `pdf`.
* **`structuredData`** — a summary of machine-readable data published by the page.
* **`jsonLd`** — the actual structured data, when available.
* **`links`** — same-site links for pagination and detail pages.
* **`httpEtag`** — the server validator to send on the next run.
* **`extractorVersion`** — the version of the extraction logic that produced the page.

### Give models Markdown

Use `markdown` when sending page content to a language model.

`text` contains the entire visible page, so the model also receives navigation, cookie banners, and other page furniture.

`markdown` preserves the structure of the main content. That structure carries information that plain text loses.

For example, a pricing table flattened into text might become:

```text
Starter 5 seats $29 Pro 25 seats $99
```

The reader has to guess which numbers belong to which tier.

Markdown preserves the table, headings, lists, and sections that tell the model how those pieces relate.

### One exception

`markdown` is an empty string when the page was retrieved through a text-only method such as Jina or a vendor API. Those services return prose without HTML to convert.

If `markdown` is empty, use `text`. Do not treat the page as a failed crawl.

### `extractorVersion` lets you reprocess old pages

Store `extractorVersion` with the page.

When that stored version is older than the exported `EXTRACTOR_VERSION`, re-process the stored content. Otherwise, an improvement to the extractor only affects pages crawled after the improvement was released.

---

## When a page cannot be read

A failed page returns a result instead of throwing an exception.

That means one failure in a batch of 50 pages does not unwind the entire batch.

```typescript
if (!result.ok) {
  result.reason;
  result.failureClass;
  result.detail;
  result.bodyReceived;
  result.retryAfterMs;
}
```

`reason` identifies the failure:

* `blocked`
* `unreachable`
* `empty`
* `quarantined`
* `no_lane_available`

`failureClass` tells the caller what kind of problem it is:

* **`transient`** — timeouts, DNS failures, 5xx responses, and bot walls. Try again later.
* **`structural`** — 404s, robots exclusions, and disabled targets. Retrying will not fix the problem until something changes.

This distinction makes monitoring useful. Consecutive `structural` failures can identify a source that should be retired. `transient` failures are expected to recover and should be handled differently.

`retryAfterMs` is populated when the origin sends a `Retry-After` response.

---

## Design decisions

### Every hostname is checked before fetching

A domain can point anywhere, including `127.0.0.1` or a cloud metadata address.

`oliver-crawl` resolves the hostname before making the request and refuses private addresses. It checks **every address** returned by DNS, not just the first one.

It repeats the check after every redirect because a redirect is another destination chosen by the remote site.

The same protection is available through the exported `isSafeHttpUrl` function for URLs you are about to pass to another component.

### Every page is checked for prompt injection

Web pages can contain instructions aimed at the AI that will read them, such as attempts to override the AI's existing instructions.

`oliver-crawl` filters every page before returning it, including content retrieved through paid APIs and data files such as calendar feeds.

A page that triggers the filter returns:

```typescript
reason: 'quarantined'
```

It is not passed through to the caller.

The result also contains:

```typescript
result.quarantine
```

This includes the signals that triggered the filter, the page title, and sanitized text. That gives the calling system enough information to create a review task instead of silently losing the page.

### The library identifies when a model is unnecessary

Many pages already publish structured data. That data is free to read, exact, and does not require a language model.

```typescript
if (page.structuredData.hasContentData) {
  useJsonLd(page.jsonLd);
} else {
  await extractWithModel(page.markdown);
}
```

Checking only whether `jsonLd` exists is insufficient. A site may publish `WebSite`, `Organization`, and `BreadcrumbList` on every page even when the page has no useful content data.

`hasContentData` looks for content types such as `Product`, `Article`, `Recipe`, `Event`, and `JobPosting` while ignoring that site-level metadata.

### Unchanged pages are detected before expensive processing

A site checked hourly is fetched 24 times a day, and most of those fetches return a page identical to the one before it.

`oliver-crawl` uses three increasingly expensive signals:

1. **Sitemap `lastmod`** — if the sitemap says the page has not changed, the page is never requested.
2. **HTTP validators** — the server can return `304 Not Modified` without sending the page again.
3. **Content comparison** — if the page was downloaded but its content is identical, downstream processing is skipped.

```typescript
const run = await crawlSite(crawler, target, {
  useSitemap: true,
  priorLastmod: saved.lastmod,
  priorValidators: saved.validators,
});

run.skippedByLastmod;
run.notModified;
run.unchanged;
```

The sitemap saves the most because it can report which pages changed in a single request. Asking every page individually costs one request per page.

A site that changes weekly but is checked hourly can therefore settle at roughly one real fetch and one extraction per week.

Store:

```typescript
run.validators
run.lastmod
```

and pass them into the next run as `priorValidators` and `priorLastmod`.

The library does not persist this information itself.

---

## Crawling a site

`crawlSite` handles multiple pages. You decide how far it can go.

```typescript
import { crawlSite } from '@oliver/crawl-core';

const run = await crawlSite(
  crawler,
  { baseUrl: 'https://testsite.com' },
  {
    followLinks: true,
    maxDepth: 2,
    maxPages: 50,
  }
);
```

| Option             | What it reaches                                           |
| ------------------ | --------------------------------------------------------- |
| `followLinks`      | Same-site pages reachable through links, up to `maxDepth` |
| `useSitemap`       | URLs listed in `/sitemap.xml`                             |
| `followPagination` | Pages reached through "Next page" pagination links        |

With none enabled, one URL produces one page.

### Crawling is deliberately polite

Requests are made one at a time. The crawler honors `Crawl-delay` from `robots.txt`.

It also prevents duplicate work. URLs that redirect to the same destination and URLs that differ only by a trailing slash or tracking parameter are treated as the same page.

That means a site whose navigation links every page to every other page still terminates.

Configure request pacing with:

```typescript
createCrawler({
  minHostIntervalMs: 500,
  adaptiveThrottleMultiplier: 2,
  cacheTtlMs: 60_000,
});
```

`adaptiveThrottleMultiplier` uses the host's average response latency to determine how long to wait. A slow site receives more breathing room; the setting can only make the crawler slower.

`Retry-After` is always honored.

For long crawls, use `maxDurationMs` as well as `maxPages`. Fifty pages taking 30 seconds each is a 25-minute run, which a page-count limit does not capture.

### Resume an interrupted crawl

Long crawls can be stopped and continued.

`onProgress` emits a serializable snapshot after each page. Pass that snapshot back through `resumeFrom` to continue from where the crawl stopped.

### Map or search a site without crawling everything

Two narrower entry points handle discovery.

**`mapSite`** finds a site's URLs from its sitemap, declared feeds, and homepage links. It reads the listing documents and homepage once so you can understand the site's structure before deciding which pages to crawl.

**`searchSite`** submits a query to the site's own search form. This is free and can find pages that neither links nor a sitemap expose.

---

## Beyond HTML

`oliver-crawl` can fetch feeds, calendars, CSV, and JSON files. `contentKind` tells you what you received.

```typescript
if (page.contentKind === 'csv') {
  myCsvParser(page.text);
}
```

These files are returned in `text` exactly as the server sent them, decoded but otherwise unmodified.

The library does not parse them into application-specific objects because the correct schema belongs to your application. An inventory CSV and a survey-response CSV use the same file format but represent completely different data.

Fetching these files is useful because a site's own data source is often more accurate and stable than the HTML page that displays it. A calendar feed, for example, can provide the actual schedule instead of requiring you to infer it from a rendered page.

### Images and PDFs

Images, video, and other binary files are refused. Running an HTML parser over a JPEG would produce meaningless output.

PDFs are supported when the optional `unpdf` package is installed. Without it, the crawl returns a failure that identifies the missing package rather than silently skipping the document.

For pages where the useful content is inside an image — such as a scanned menu, poster, or specification sheet — the crawler provides:

```typescript
page.candidateContentImages
```

This ranks the images most worth examining.

Identifying those images is included in the crawl. Actually reading them requires a vision model, which your application can choose to run.

---

## Search

Fetching a URL you already know about does not require a search provider.

Finding URLs you do not know about does.

Search providers charge for queries, so `crawler.search()` requires a provider key while ordinary page crawling does not.

```typescript
const found = await crawler.search(
  'industrial flow meter suppliers'
);

if (found.ok) {
  found.results;
  found.provider;
} else {
  found.reason;
}
```

Possible failure reasons are:

* `no_provider_configured`
* `no_results`
* `budget_refused`
* `error`

The result explains why a search returned nothing. `no_provider_configured` requires configuration; `no_results` means the query produced no matches.

### Search and crawl together

`searchAndCrawl` searches for pages and then crawls the results:

```typescript
import { searchAndCrawl } from '@oliver/crawl-core';

const found = await searchAndCrawl(
  crawler,
  'industrial flow meter suppliers'
);

found.pages;
found.skipped;
```

Search results pass through the same hostname safety checks as every other URL. Search providers return sites you have not vetted, so their results cannot be sent directly to a fetcher without reintroducing the request-forgery risk the crawler is designed to prevent.

---

## Configuration

Everything is optional except `userAgent`. Environment variables mirror the constructor options.

```bash
OLIVER_CRAWL_USER_AGENT="MyBot/1.0 (+https://mysite.com/bot)"
OLIVER_CRAWL_LOCAL_RENDER=1
OLIVER_CRAWL_AUTO_ROBOTS=1
OLIVER_CRAWL_FIRECRAWL_KEY=...
OLIVER_CRAWL_SERPER_KEY=...
```

Or configure the crawler directly:

```typescript
createCrawler({
  userAgent: 'MyBot/1.0',
  onUsage: (event) => myMetrics.record(event),
  checkBudget: () => spentToday < myCap,
  renderWhenTextBelow: 600,
  limits: {
    maxBodyBytes: 5_000_000
  },
});
```

### Cost controls

`onUsage` reports every external call and its cost.

`checkBudget` is consulted before every paid call and can veto it.

Together, they let your application control spending without requiring the crawler to know anything about your metrics system or budget.

### Robots

`autoRobots` is off by default.

Applications that already track robots posture can remain the source of truth, and enabling automatic resolution would add an unexpected network request for each unknown target.

When enabled, the crawler fetches `robots.txt` for an unknown host and caches the result for the lifetime of the process. That means one request per host rather than one per page.

### Authenticated pages

You can provide credentials you already hold through `headers` on a target.

Those headers are sent only to that target's own host. A redirect cannot carry a bearer token to another origin.

The library never acquires, stores, or refreshes credentials.

### No database or application framework

`oliver-crawl` does not maintain a database.

Your application owns persistence, scheduling, and conversion of crawled pages into your own domain objects. The library provides the crawling layer without imposing a larger application framework.

---

## Documentation

| Document                                                                                                   | Purpose                                         |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [`ADOPTING.md`](https://github.com/oliver-chase/oliver-crawl/blob/main/docs/ADOPTING.md)                   | Starting from a new project                     |
| [`EXISTING-PROJECTS.md`](https://github.com/oliver-chase/oliver-crawl/blob/main/docs/EXISTING-PROJECTS.md) | Replacing existing crawling code                |
| [`ARCHITECTURE.md`](https://github.com/oliver-chase/oliver-crawl/blob/main/docs/ARCHITECTURE.md)           | Request flow, module map, and design boundaries |
| [`LANES.md`](https://github.com/oliver-chase/oliver-crawl/blob/main/docs/LANES.md)                         | The retrieval ladder, rung by rung              |
| [`REFERENCE.md`](https://github.com/oliver-chase/oliver-crawl/blob/main/docs/REFERENCE.md)                 | Every option and return field                   |
| [`MIGRATION.md`](https://github.com/oliver-chase/oliver-crawl/blob/main/docs/MIGRATION.md)                 | What moved here and where it came from          |
| [`TROUBLESHOOTING.md`](https://github.com/oliver-chase/oliver-crawl/blob/main/docs/TROUBLESHOOTING.md)     | Failures organized by symptom                   |
| [`DECISIONS.md`](https://github.com/oliver-chase/oliver-crawl/blob/main/docs/DECISIONS.md)                 | Why the code works the way it does              |
| [`BACKLOG.md`](https://github.com/oliver-chase/oliver-crawl/blob/main/docs/BACKLOG.md)                     | Known gaps and planned work                     |

---

## Status

`oliver-crawl` is strict TypeScript and builds to `dist/`.

Run:

```bash
npm run check
```

This runs:

* Type checking
* Unit tests
* The decision-record gate
* The comment-budget gate

For network-based testing, run:

```bash
npm run live
```

This exercises the library against real websites.

Installation is also tested as a genuine Git dependency rather than a local path.

**Requirements:** Node 20 or later. Edge and serverless runtimes are supported, although local browser rendering is unavailable in those environments.

## License

MIT

---

## About

TypeScript web crawler that screens every URL before fetching it, returns clean Markdown, identifies when a page's structured data makes an LLM call unnecessary, and skips unchanged pages on re-crawl.

Free by default. Paid APIs are used only when explicitly requested.
