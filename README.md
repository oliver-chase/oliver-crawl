# oliver-crawl

A TypeScript library that fetches web pages and returns their main content as Markdown, built to be pointed at the same sites on a schedule without paying twice for pages that have not changed.

Downloading HTML is the easy part. Two problems show up after that, and both are easy to underestimate until a pipeline is running every hour.

**The first is safety.** A crawler requests whatever URL it is handed, and that URL is frequently chosen by somebody else — a user submission, a search result, a redirect. Point one at `169.254.169.254`, the address that serves instance metadata on most cloud providers, and it will fetch your credentials and hand them back as page text. So every hostname is resolved and checked against private address ranges before a request goes out, and checked again after every redirect.

**The second is cost.** In a pipeline that ends at a language model, the fetch is the cheap step and the model call after it is not — and that call usually runs on every page of every run, including the pages that are byte-identical to the last time you read them. A site polled hourly but updated weekly gets re-extracted around 160 times for each time it needed to be. So the library answers "did this change?" before the expensive work rather than after it, using signals that cost one request or none.

---

## Install

```bash
npm install github:oliver-chase/oliver-crawl#v0.17.0
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

No API key, no account, no configuration file. Pages are fetched from your own machine, so the only cost is bandwidth, and that is the default path rather than a trial mode. Node 20 or later; it also runs on edge and serverless runtimes, where local browser rendering is unavailable.

---

## How it reads a page

Most pages answer a plain HTTP request, so that is what the library tries first. When a page does not come back, it escalates through four further methods, and each one exists for a specific failure the method before it cannot solve.

1. **Request the page.** An ordinary HTTP GET, which works for most of the web.
2. **Render it in a real browser.** Some sites return an HTML shell whose content only appears once JavaScript has run, so a plain fetch yields navigation and nothing else. Chromium runs locally on your own machine: `npx playwright install chromium` once, then `localRender: true` on the crawler.
3. **Retry through Jina Reader.** Some sites reject any client that does not look like a person, regardless of what the page contains. [Jina Reader](https://jina.ai/reader) requests it from its own infrastructure and returns the text, free and with no account.
4. **Call a paid API.** Firecrawl and Apify run commercial anti-bot infrastructure, which is what a site is paying for when it defeats the three steps above.
5. **Read the archived copy.** When every live method has failed, the Internet Archive may still hold the page.

**Steps 1 to 3 run on your own machine and cost nothing beyond bandwidth.** Step 4 is off unless a request opts into it with `lanes: ['own', 'vendor']`, because the failure mode of an accidental vendor call is a bill rather than an error — a configured API key alone is deliberately not enough, and a test fails the build if a paid rung is ever reached without the opt-in. Step 5 is off unless you set `useArchiveFallback: true`, and even then it runs only for targets whose robots posture is explicitly `allow`, so it recovers a page a site was willing to serve rather than working around one it refused.

**The order is deliberate, and cost is the reason.** A 403 usually means a site has classified the request as automated traffic, not that the content is private, and a locally rendered browser clears most of those for free. Escalating to a paid API on the first rejection would spend money reading pages that step 2 handles.

The ladder is not re-walked from the top every time. When a host is finally read by a rung further down, that rung is remembered for 30 minutes and tried first on the next page, so a site that always rejects a plain fetch does not cost one guaranteed wasted request per page. The memory is only a starting point and expires on its own, so a stale one costs an extra request rather than a lost page.

---

## What comes back

A crawl returns extracted page objects rather than raw HTML.

```ts
const page = result.pages[0];

page.markdown         // main content as Markdown, with structure intact
page.text             // every visible word, including nav, footer and cookie banner
page.contentKind      // 'html' | 'calendar' | 'csv' | 'json' | 'feed' | 'text' | 'pdf'
page.structuredData   // what machine-readable data the page publishes, summarised
page.jsonLd           // that data itself, if any
page.links            // same-site links, for pagination and detail pages
page.httpEtag         // pass back next run to skip an unchanged fetch
page.extractorVersion // which extraction produced this page
```

**Feed a model `markdown`, not `text`.**

`text` is the whole visible page, so a model reading it pays for the navigation and the cookie banner alongside the content. `markdown` is the main content region with the page's own structure preserved, and that structure carries meaning the words alone do not.

Plain text collapses that structure: headings disappear, tables become sequences of numbers, and navigation sits next to content with no boundary between them. Markdown keeps the hierarchy, tables, lists, and sections that tell a model what belongs together. Flatten a pricing table into plain text and it reads:

```
Starter 5 seats $29 Pro 25 seats $99
```

Which number is the seat count and which is the price? Which tier does each belong to? The page's author already answered that when they wrote it as a table, and Markdown keeps the answer where flat text discards it.

One exception is worth knowing before you rely on it: `markdown` is an empty string on the text-only rungs, Jina and the vendor APIs, because those return prose with no HTML to convert. Read `text` when `markdown` is empty rather than treating the page as failed.

`extractorVersion` exists for the same reason. Store it beside the page, and when the stored value falls behind the exported `EXTRACTOR_VERSION`, re-process — otherwise an improvement to extraction only ever reaches pages crawled after it shipped, and there is no way to apply it retroactively later.

### When a page cannot be read

Failure is returned as a value, not thrown. One unreadable page in a batch of fifty produces a result object rather than an exception that unwinds the loop and abandons the other forty-nine.

```ts
if (!result.ok) {
  result.reason;        // 'blocked' | 'unreachable' | 'empty' | 'quarantined' | 'no_lane_available'
  result.failureClass;  // 'transient' — try later | 'structural' — needs a fix
  result.detail;        // what happened, in words
  result.bodyReceived;  // did an origin answer at all?
  result.retryAfterMs;  // set when the origin sent Retry-After
}
```

`failureClass` is the field to branch on. `transient` covers timeouts, DNS failures, 5xx responses and bot walls, all conditions that may differ in an hour. `structural` covers 404s, robots exclusions and disabled targets, where retrying changes nothing until something is fixed.

Counting consecutive `structural` failures per source is how a dead source gets retired before anyone notices it by hand. Counting `transient` ones tells you nothing, which is why the two are separated here rather than left for a caller to infer from `detail`.

---

## Design decisions

### Every hostname is resolved and checked before the request goes out

Anyone who controls a domain controls where it points, including at `127.0.0.1` or at the cloud metadata address. A crawler that resolves and fetches on command will retrieve whatever sits there and return it as ordinary page content, which is server-side request forgery with the crawler as the confused deputy.

So resolution happens first and the request is refused if the name lands on a private address. Every address in the DNS answer is checked rather than only the first, since a name can resolve to several. The check runs again after each redirect, because a redirect is a second destination the same attacker also chose.

`isSafeHttpUrl` is exported for the same check on URLs you are about to hand to something else.

### Every page is filtered for prompt injection before it reaches you

A web page can carry instructions addressed to whatever AI reads it next, the "ignore your previous instructions" family, and a crawler that returns them intact has delivered an attack into your extraction step.

Every page passes a prompt-injection filter before it is returned, including pages retrieved through the paid APIs and data files such as calendar feeds. A page that trips the filter comes back with `reason: 'quarantined'` and is not handed over.

Quarantine carries evidence with it, in `result.quarantine`: the signals that fired, the page title, and the sanitised text. Without that, a quarantine is indistinguishable from a fetch failure at the call site, and a pipeline whose rule is "never silently lose a page" has nothing to build a review task from.

### The library says when a language model is unnecessary

Many pages already publish a machine-readable description of themselves. Reading that is free, exact, and cannot hallucinate, so the useful question before every extraction is whether a model is needed at all.

```ts
if (page.structuredData.hasContentData) {
  useJsonLd(page.jsonLd);
} else {
  await extractWithModel(page.markdown);
}
```

Testing `jsonLd.length > 0` yourself gives the wrong answer, which is the reason this field exists. Most structured data in the wild describes the site rather than the page: a retailer publishes `WebSite`, `Organization` and `BreadcrumbList` on every page, including the ones with no product on them. `hasContentData` counts only the types that describe content — `Product`, `Article`, `Recipe`, `Event`, `JobPosting` and the rest — and ignores site furniture.

### An unchanged page is detected before it is downloaded

A site polled hourly is fetched 24 times a day, and almost every one of those fetches returns a page identical to the one before it. Three mechanisms cut that down, and they are tried cheapest first.

```ts
const run = await crawlSite(crawler, target, {
  useSitemap: true,
  priorLastmod: saved.lastmod,
  priorValidators: saved.validators,
});

run.skippedByLastmod;  // sitemap says unchanged — never requested
run.notModified;       // server answered 304 — nothing downloaded
run.unchanged;         // downloaded, identical content — skip re-processing
```

The sitemap saves the most, because it reports which of a site's pages changed in a single request, where asking each page individually costs one request per page. The result is that a weekly-changing site polled hourly settles at roughly one real fetch and one extraction per week.

`run.validators` and `run.lastmod` are what you store to make the next run cheap. Pass them back as `priorValidators` and `priorLastmod`; nothing is persisted by the library itself.

---

## Crawling a site

`crawlSite` walks a site rather than a single URL, and how far it reaches is set explicitly.

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
| `followLinks` | Every page reachable by same-site links, to `maxDepth` |
| `useSitemap` | Whatever `/sitemap.xml` lists |
| `followPagination` | "Next page" links only, for paginated listings |

With none of them set, one URL yields one page.

Requests go out one at a time, because parallel requests to a small site are how a crawler gets itself blocked, and any `Crawl-delay` published in the site's robots.txt is honoured. Pages are never fetched twice — including URLs that redirect to the same destination and URLs differing only by a trailing slash or a tracking parameter — so a site whose navigation links every page to every other page still terminates.

```ts
createCrawler({
  minHostIntervalMs: 500,          // minimum gap between requests to one host
  adaptiveThrottleMultiplier: 2,   // slow sites are given proportionally more room
  cacheTtlMs: 60_000,              // same URL twice in a minute costs one request
});
```

`adaptiveThrottleMultiplier` waits the host's own average response latency multiplied by this value. Latency is the origin telling you how loaded it is, and a fixed delay cannot hear that; the setting can only ever make the crawler more polite, never less.

`Retry-After` is obeyed. Bound a long run with `maxDurationMs` rather than a page count alone: fifty pages at thirty seconds each is a twenty-five minute run, which a `maxPages` limit does not express.

A long crawl can also be interrupted and continued. `onProgress` emits a serialisable snapshot after each page, and passing that snapshot back as `resumeFrom` continues from where it stopped instead of starting over.

Two narrower entry points cover the cases where a full crawl is the wrong tool. `mapSite` returns a site's URLs from its sitemap, its declared feeds and its homepage links, reading the listing documents and the homepage once, which is enough to learn what a site contains before deciding to read any of it. `searchSite` submits to the site's own search form, which is free and reaches pages that neither links nor a sitemap expose.

---

## Beyond HTML

Feeds, calendars, CSV and JSON are fetched rather than refused, and `contentKind` tells you which one you are holding.

```ts
if (page.contentKind === 'csv') {
  myCsvParser(page.text);
}
```

These arrive in `text` exactly as the server sent them, decoded but otherwise unmodified. The library does not parse them, because the shape they should become is defined by your schema and not by the file: a CSV of inventory rows and a CSV of survey responses are the same format and completely different data.

Fetching them at all is the point. A site's own data file is usually more accurate and more stable than the page rendering it, and a calendar feed in particular is the difference between reading a venue's schedule and scraping a guess at it.

Images, video and other binaries are refused, since running an HTML parser over a JPEG produces confident nonsense. PDFs are read if the optional `unpdf` package is installed; without it the crawl reports a failure naming the package rather than skipping the document silently.

Where a page's substance sits inside an image rather than its text — a scanned menu, a poster, a specification sheet — `page.candidateContentImages` ranks the images worth examining, best first. Identifying them is free and included; reading them needs a vision model and is yours to run.

---

## Search

Fetching a page you already know about is free. Finding pages you do not know about is a different surface with a different cost, because every reliable search API charges for queries, so `crawler.search()` needs a provider key while reading pages never does.

```ts
const found = await crawler.search('industrial flow meter suppliers');

if (found.ok) {
  found.results;   // [{ url, title, snippet }]
  found.provider;  // which provider answered
} else {
  found.reason;    // 'no_provider_configured' | 'no_results' | 'budget_refused' | 'error'
}
```

Search reports why it came back empty rather than returning a bare empty array, because "no provider is configured" and "this query has no results" call for opposite responses from a caller.

To read the results rather than list them, `searchAndCrawl` runs the search and crawls what it finds:

```ts
import { searchAndCrawl } from '@oliver/crawl-core';

const found = await searchAndCrawl(crawler, 'industrial flow meter suppliers');
found.pages;
found.skipped;
```

Those URLs pass through the same hostname screening as any other. A search provider returns results from sites you have not vetted, so handing them straight to a fetcher would reintroduce exactly the request-forgery exposure the screening exists to close.

---

## Configuration

Everything is optional except `userAgent`, and the environment variables mirror the constructor.

```bash
OLIVER_CRAWL_USER_AGENT="MyBot/1.0 (+https://mysite.com/bot)"
OLIVER_CRAWL_LOCAL_RENDER=1     # enable the free local-Chromium rung
OLIVER_CRAWL_AUTO_ROBOTS=1      # resolve an unknown robots posture by fetching robots.txt
OLIVER_CRAWL_FIRECRAWL_KEY=...  # or FIRECRAWL_API_KEY
OLIVER_CRAWL_SERPER_KEY=...     # or SERPER_API_KEY
```

```ts
createCrawler({
  userAgent: 'MyBot/1.0',
  onUsage: (event) => myMetrics.record(event),   // one event per external call
  checkBudget: () => spentToday < myCap,         // consulted before every paid call
  renderWhenTextBelow: 600,                      // escalate a suspiciously thin page
  limits: { maxBodyBytes: 5_000_000 },
});
```

`onUsage` and `checkBudget` are the two halves of spend control: the first reports what each external call cost, and the second vetoes a paid call before it happens. Both exist so the library never needs to know what your database or your budget is.

`autoRobots` is off by default because a consumer that already tracks robots posture in its own records should stay the source of truth, and adding a silent network call per target would be a surprise. Turned on, the crawler resolves an unknown posture itself and caches the answer per host for the process lifetime, so it costs one request per host rather than one per page.

Pages behind a login are reachable with credentials you already hold: `headers` on a target are sent to that target's own host and nowhere else, so a redirect cannot walk a bearer token to another origin. The library never acquires, stores or refreshes them.

The library holds no database. Persistence, scheduling, and turning pages into your own domain objects stay in your application, which is what lets it drop into an existing codebase without bringing a framework along with it.

---

## Documentation

| | |
|---|---|
| **[ADOPTING.md](docs/ADOPTING.md)** | Starting from a new project |
| **[EXISTING-PROJECTS.md](docs/EXISTING-PROJECTS.md)** | Replacing crawling code you already run |
| **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** | Request flow, module map, design boundaries |
| **[LANES.md](docs/LANES.md)** | The retrieval ladder, rung by rung |
| **[REFERENCE.md](docs/REFERENCE.md)** | Every option and return field |
| **[MIGRATION.md](docs/MIGRATION.md)** | Provenance: what moved here, from where |
| **[TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** | Failures you will hit, listed by symptom |
| **[DECISIONS.md](docs/DECISIONS.md)** | Why the code is the way it is, indexed by the defect each choice prevents |
| **[BACKLOG.md](docs/BACKLOG.md)** | Known gaps — read before assuming a capability exists |

## Status

Strict TypeScript, building to `dist/`. `npm run check` runs the typecheck, the unit suite, the decision-record gate and the comment-budget gate; `npm run live` exercises the library against real websites over the network. Installation is verified as a genuine git dependency rather than a local path.

Node 20 or later. Edge and serverless runtimes are supported, with local browser rendering unavailable there.

## License

MIT
