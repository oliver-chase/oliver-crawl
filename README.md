# oliver-crawl

A TypeScript library for reading web pages: fetch, clean, extract, repeat on a schedule.

Two problems drive its design.

A crawler fetches whatever URL it is given. Point one at `169.254.169.254` and it will retrieve your cloud credentials. So every hostname here is resolved and checked against private address ranges before a request is made, and re-checked after each redirect.

The second is cost. In most crawling pipelines the fetch is cheap and the language-model call after it is not — and that call runs on every page, including the pages that have not changed since the last run. So pages come back as structured Markdown, flagged with whether a model is needed at all, and unchanged pages are detected before they are fetched rather than after.

---

## Install

```bash
npm install github:oliver-chase/oliver-crawl#v0.9.1
```

```ts
import { createCrawler } from '@oliver/crawl-core';

const crawler = createCrawler({ userAgent: 'MyBot/1.0 (+https://mysite.com/bot)' });

const result = await crawler.crawl(
  { baseUrl: 'https://example.com', robotsPolicy: 'allow' },
  'https://example.com/catalog',
);

if (result.ok && !result.notModified) {
  console.log(result.pages[0].markdown);
}
```

No API key, no account, no configuration file. That path costs nothing per page and is the default.

---

## How it reads a page

Most pages answer a plain HTTP request, so that is what it tries first. When that is not enough it escalates, and each step exists for a failure the previous one cannot solve:

1. **Request the page.** Works for most of the web.
2. **Render it in a real browser** when the HTML arrives nearly empty because the content only appears once scripts run. Chromium runs locally; `npx playwright install chromium` once enables it.
3. **Retry through [Jina Reader](https://jina.ai/reader)** when a site rejects anything that does not look like a person browsing. Free, no signup.
4. **Call a paid API** (Firecrawl or Apify) for the remainder — typically sites paying a commercial service specifically to keep crawlers out.

Steps 1 to 3 run on your own machine and cost nothing beyond bandwidth. Step 4 is **off unless a request explicitly asks for it**; a paid key sitting in your environment is not enough on its own, and a test fails the build if a paid service is ever reached without that opt-in.

The order is deliberate. A 403 is usually a bot wall rather than a genuine refusal, and a real browser clears most of them, so escalating straight to a paid API on the first rejection would spend money reading pages step 2 handles for free.

Web search is separate and always costs money: there is no free search API worth relying on, so `crawler.search()` needs a key. Reading pages never requires one.

---

## What comes back

```ts
const page = result.pages[0];

page.markdown        // main content as Markdown
page.text            // full visible text, including nav and footer
page.structuredData  // whether the page publishes machine-readable data
page.contentKind     // 'html' | 'calendar' | 'csv' | 'json' | 'feed' | 'text'
page.jsonLd          // that structured data, if present
page.links           // same-site links
page.httpEtag        // pass back next run to skip an unchanged fetch
```

Feed a model `markdown`, not `text`. `text` is every visible word on the page, navigation and cookie banner included. `markdown` is the main content with the page's own structure preserved — and that structure carries meaning. A pricing table reduced to plain text reads:

```
Starter 5 seats $29 Pro 25 seats $99
```

Which number is the seat count and which is the price? Which tier did each belong to? The page's author already answered that when they wrote the table. Markdown keeps the answer. Flat text discards it.

Failures are returned rather than thrown. A page that cannot be read produces a result object with `ok: false` instead of an error that unwinds your call stack, so one bad page in a batch of fifty does not abort the other forty-nine:

```ts
if (!result.ok) {
  result.reason;        // 'blocked' | 'unreachable' | 'empty' | 'quarantined' | 'no_lane_available'
  result.failureClass;  // 'transient' — try later | 'structural' — needs a fix
  result.detail;        // what happened, in words
}
```

`failureClass` is the field to act on. `transient` covers timeouts, DNS failures, 5xx responses and bot walls — conditions that may differ in an hour. `structural` covers 404s, robots exclusions and disabled sources, where retrying changes nothing. Counting consecutive `structural` failures per source is how a dead source gets retired before a human notices it.

---

## Four design decisions

### URLs are screened before they are requested

Anyone who controls a domain can point it at `127.0.0.1`, or at `169.254.169.254` — the address that dispenses cloud credentials on most providers. A crawler that resolves and fetches on command will retrieve those on their behalf.

Every hostname is resolved first and rejected if it lands on a private address. Every DNS answer is checked, not only the first. The check repeats after each redirect, because a redirect is a second URL the attacker also chose. 48 tests cover this behaviour alone.

### Pages are filtered before a model reads them

Web pages can carry instructions aimed at whatever AI processes them — the "ignore your previous instructions" family. Every page passes a prompt-injection filter before it is returned, including pages retrieved by the paid APIs and data files such as calendar feeds. A page that trips the filter comes back with `reason: 'quarantined'` and is not handed over.

### The library reports when no model is needed

Many pages publish machine-readable descriptions of themselves. Reading that data is free, exact, and cannot hallucinate.

```ts
if (page.structuredData.hasContentData) {
  useJsonLd(page.jsonLd);
} else {
  await extractWithModel(page.markdown);
}
```

Testing `jsonLd.length > 0` yourself does not work, which is why this field exists. Most structured data in the wild describes the site rather than the page. A retailer publishes `WebSite`, `Organization` and `BreadcrumbList` on every page including the ones with no `Product` on them at all. `hasContentData` counts only the types that describe content — `Product`, `Article`, `Recipe`, `Event`, `JobPosting` and the rest — and ignores site furniture.

### Repeat crawls converge on free

A site polled hourly is fetched 24 times a day, and nearly every fetch returns a page identical to the last. Three mechanisms cut that down, cheapest first:

```ts
const run = await crawlSite(crawler, target, {
  useSitemap: true,
  priorLastmod: saved.lastmod,
  priorValidators: saved.validators,
});

run.skippedByLastmod;  // sitemap says unchanged — never requested
run.notModified;       // server says unchanged — nothing downloaded
run.unchanged;         // downloaded, identical — skip re-processing
```

The first saves the most. A sitemap reports which of a site's pages have changed in one request; asking each page individually costs one request per page. A weekly-changing site polled hourly settles at roughly one real fetch per week.

---

## Crawling a site

```ts
import { crawlSite } from '@oliver/crawl-core';

const run = await crawlSite(crawler, { baseUrl: 'https://testsite.com' }, {
  followLinks: true,
  maxDepth: 2,
  maxPages: 50,
});
```

| Option | Reaches |
|---|---|
| `followLinks` | Every page reachable by same-site links |
| `useSitemap` | Whatever `/sitemap.xml` lists |
| `followPagination` | "Next page" links only, for paginated listings |

With none of these, one URL yields one page.

Requests go out one at a time. Parallel requests to a small site are how crawlers get blocked, and any `Crawl-delay` the site publishes in robots.txt is honoured. Pages are never fetched twice — including URLs that redirect to the same destination, and URLs differing only by a trailing slash or a tracking parameter — so a site whose navigation links every page to every other page still terminates.

```ts
createCrawler({
  minHostIntervalMs: 500,
  adaptiveThrottleMultiplier: 2,   // slower sites are given more room
  cacheTtlMs: 60_000,
});
```

`Retry-After` is obeyed. `maxDurationMs` bounds a run by elapsed time, which a page limit does not: fifty pages at thirty seconds each is a twenty-five minute run.

A long crawl can be interrupted and continued. `onProgress` emits a serialisable snapshot after each page; passing it back as `resumeFrom` continues from that point instead of starting over.

To learn what a site contains without reading it, `mapSite` returns its URLs from the sitemap, its declared feeds, and its homepage links — one page body fetched in total. To find pages *about* something on a site you already know, `searchSite` submits to the site's own search form, which is free and reaches pages neither links nor a sitemap expose.

---

## Beyond HTML

Feeds, calendars, CSV and JSON are retrieved rather than rejected:

```ts
if (page.contentKind === 'csv') {
  myCsvParser(page.text);
}
```

The library returns these files exactly as the server sent them, decoded but unmodified. It does not parse them, because the shape they should become is defined by your schema, not by the file — a CSV of inventory rows and a CSV of survey responses are the same format and completely different data.

Retrieving them at all is the point. A site's own data file is usually more accurate and more stable than the page rendering it, and until recently this library refused to fetch one.

Images, video and binaries are rejected — running an HTML parser over a JPEG produces confident nonsense. PDFs are read if you install the optional `unpdf` package; without it the library reports a failure naming the package rather than silently skipping the document.

Where a page's substance sits inside an image rather than its text — a scanned menu, a poster, a specification sheet — `page.candidateContentImages` ranks the images worth examining. Identifying them is free and included. Reading them requires a vision model and is yours to run.

---

## Search

```ts
const found = await crawler.search('industrial flow meter suppliers');
await crawler.search('return policy', { site: 'example-retailer.com' });
```

To read the results rather than list them:

```ts
import { searchAndCrawl } from '@oliver/crawl-core';

const found = await searchAndCrawl(crawler, 'industrial flow meter suppliers');
found.pages;
found.skipped;
```

Search results pass through the same screening as any other URL. A search provider returns URLs from sites you have not vetted, so passing them directly to a fetcher reintroduces exactly the request-forgery risk the screening exists to prevent.

---

## Configuration

Optional.

```bash
OLIVER_CRAWL_USER_AGENT="MyBot/1.0 (+https://mysite.com/bot)"
OLIVER_CRAWL_LOCAL_RENDER=1
OLIVER_CRAWL_AUTO_ROBOTS=1
FIRECRAWL_API_KEY=...
SERPER_API_KEY=...
```

```ts
createCrawler({
  userAgent: 'MyBot/1.0',
  onUsage: (e) => myMetrics.record(e),
  checkBudget: () => spentToday < myCap,
  limits: { maxBodyBytes: 5_000_000 },
});
```

The library holds no database. Persistence, scheduling, and converting pages into your domain's objects stay in your application — which is why it drops into an existing codebase without bringing a framework with it.

---

## Documentation

| | |
|---|---|
| **[ADOPTION.md](docs/ADOPTION.md)** | Starting from a new project |
| **[EXISTING-PROJECTS.md](docs/EXISTING-PROJECTS.md)** | Replacing crawling code you already run |
| **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** | Request flow, module map, design boundaries |
| **[LANES.md](docs/LANES.md)** | The rung ladder, in order |
| **[REFERENCE.md](docs/REFERENCE.md)** | Every option and return field |
| **[MIGRATION.md](docs/MIGRATION.md)** | Provenance: what moved here, from where |
| **[BACKLOG.md](docs/BACKLOG.md)** | Known gaps — read before assuming a capability exists |

## Status

551 tests across 43 files. Strict TypeScript, builds to `dist/`. A separate network suite (`npm run live`, 23 checks) exercises the library against real websites, and installation is verified as a genuine git dependency. Node 20+, and runs on edge and serverless runtimes, where local rendering is unavailable.

## License

MIT
