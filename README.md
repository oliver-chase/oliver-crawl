# oliver-crawl

**Read web pages for free, without turning your crawler into a security hole.**

There are two ways to fetch a page:

- **Lane 1 — our own crawler.** No account, no API key, nothing per page.
- **Lane 2 — paid APIs** (Firecrawl, Apify). Switched off unless you ask for it.

Lane 1 handles the large majority of real pages. Lane 2 is there for the few it genuinely can't.

---

## Try it in 30 seconds

```bash
npm install github:oliver-chase/oliver-crawl#v0.4.0
```

```ts
import { createCrawler } from '@oliver/crawl-core';

const crawler = createCrawler({ userAgent: 'MyBot/1.0 (+https://mysite.com/bot)' });

const result = await crawler.crawl(
  { baseUrl: 'https://example.com', robotsPolicy: 'allow' },
  'https://example.com/events',
);

if (result.ok && !result.notModified) {
  console.log(result.pages[0].markdown); // clean Markdown, ready for an LLM
}
```

No keys. Nothing to configure. That's Lane 1, and it stays that way: a vendor key that happens to be sitting in your environment is **never** used unless you pass `lanes: ['own', 'vendor']`. Tests fail the build if a paid API is ever reached from the default path.

---

## Why "free" is real, not a trick

Lane 1 makes an ordinary HTTPS request from your own machine — the same thing your browser does when you open a page. There's no middleman to bill you. You pay the bandwidth and CPU you already own, and nothing else.

Even the two things that sound like they should cost money don't:

| | Why it's free |
|---|---|
| **JavaScript rendering** | Chromium runs on *your* machine (`npx playwright install chromium`, once) |
| **Getting past bot walls** | [Jina Reader](https://jina.ai/reader) runs a free public endpoint that needs no key |

**A paid API is only ever called if you pass `lanes: ['own', 'vendor']` and have set a key.** There's no path through this package that spends money you didn't ask it to spend.

---

## What you get back

```ts
const page = result.pages[0];

page.markdown        // main content as Markdown — headings, lists, tables, links kept
page.text            // the page's full visible text, nav and footer included
page.structuredData  // does this page publish machine-readable data? (see below)
page.contentKind     // 'html' | 'calendar' | 'csv' | 'json' | 'feed' | 'text'
page.jsonLd          // the structured data itself, if any
page.links           // other pages on the same site
page.httpEtag        // hand this back next time for a free re-crawl
```

**Use `markdown`, not `text`, when you're feeding an LLM.** They're different on purpose. `text` is everything visible on the page, nav and cookie banner included. `markdown` is just the main content, with the page's own structure intact — and that structure is the whole point. A schedule table flattened into plain text looks like this:

```
July 11 The Hold Steady 7:00 PM $25
```

Your extractor now has to guess which word is the date, which is the price, and which row they belonged to. The same table as Markdown keeps the columns, so there's nothing to guess.

If something goes wrong, you get a *value* back rather than an exception:

```ts
if (!result.ok) {
  result.reason;  // 'blocked' | 'unreachable' | 'empty' | 'quarantined' | 'no_lane_available'
  result.detail;  // plain-English explanation
}
```

---

## The four things that make this different

### 1. It refuses to be used as an attack tool

A crawler that fetches any URL you hand it is a weapon pointed at your own network. Anyone who controls a domain can point `totally-normal.example.com` at `127.0.0.1`, or at `169.254.169.254` — the address that hands out cloud server credentials.

This package resolves the hostname first and **refuses anything that lands on a private address**. It checks *every* answer DNS gives back, not just the first, and re-checks after every redirect. 48 tests cover this one behaviour.

### 2. It cleans pages before an AI ever sees them

Web pages can carry text written to hijack an AI that reads them — "ignore your previous instructions and…". Every page goes through a prompt-injection filter **before** it reaches you, including pages fetched by the paid APIs and data files like calendar feeds. Anything that trips the filter comes back as `quarantined` rather than quietly poisoning whatever you feed it into.

### 3. It tells you when you don't need an LLM at all

Plenty of pages publish machine-readable data about themselves. Reading that is free, exact, and can't hallucinate — but only if you know it's there.

```ts
if (page.structuredData.hasContentData) {
  useJsonLd(page.jsonLd);              // free and exact
} else {
  await extractWithModel(page.markdown); // the part that costs money
}
```

Checking `jsonLd.length > 0` yourself won't work, which is why this field exists. Most structured data in the wild is site furniture — a venue page will happily publish `WebSite`, `Organization` and `BreadcrumbList` and not one word about its actual events. `hasContentData` only counts data that describes the page's *content*.

### 4. Re-crawling the same site is nearly free

Checking a site every hour shouldn't cost 24 full page loads a day. There are three mechanisms, cheapest first:

```ts
const run = await crawlSite(crawler, target, {
  useSitemap: true,
  priorLastmod: saved.lastmod,       // ← from last run
  priorValidators: saved.validators, // ← from last run
});

run.skippedByLastmod;  // the site's sitemap says these didn't move — never fetched
run.notModified;       // the server said "nothing changed" — nothing downloaded
run.unchanged;         // downloaded, but identical — skip re-processing
```

A sitemap answers "which of these 500 pages changed?" in **one request**. Asking each page individually takes 500. So a site you check hourly that only changes weekly costs about one real fetch a week, not 168.

---

## Crawling a whole site

Give it one URL and let it find the rest:

```ts
import { crawlSite } from '@oliver/crawl-core';

const run = await crawlSite(crawler, { baseUrl: 'https://testsite.com' }, {
  followLinks: true,   // follow same-site links → /calendar, /menu, /locations
  maxDepth: 2,         // how many hops from the start
  maxPages: 50,        // hard ceiling
});

run.pages;     // everything found
run.failures;  // per page — one bad page never sinks the run
```

Three ways to decide what gets crawled. They work together:

| Option | What it finds |
|---|---|
| `followLinks` | Every page reachable by same-site links — the "capture everything" switch |
| `useSitemap` | Whatever the site's own `/sitemap.xml` lists |
| `followPagination` | Only "next page" links, for paginated listings |

With none of them, one URL means one page.

It crawls one request at a time on purpose — hammering a small site in parallel is how crawlers get blocked. It also honours the `Crawl-delay` a site publishes in its own robots.txt. Pages already seen are never fetched twice, including URLs that redirect to the same place and ones that differ only by a trailing slash or a tracking parameter, so a site whose nav links every page to every other page still finishes.

```ts
createCrawler({
  minHostIntervalMs: 500,           // never hit one host more than twice a second
  adaptiveThrottleMultiplier: 2,    // a slow site automatically gets more room
  cacheTtlMs: 60_000,               // same URL twice in a minute = one request
});
```

It obeys `Retry-After` when a server asks it to back off, and `maxDurationMs` caps a whole run by wall-clock time — a page limit alone won't, since 20 pages at 30 seconds each is still a ten-minute run.

---

## More than HTML

Calendar feeds, CSV and JSON are read too, not refused:

```ts
const page = result.pages[0];
if (page.contentKind === 'calendar') {
  myIcsParser(page.text);  // the raw feed, exactly as served
}
```

This matters because a site's own ICS feed is usually more accurate and more stable than scraping its calendar page. Parsing it is yours to do — turning a feed into *your* events is your app's logic — but the raw document reaches you.

Images, video, PDFs and binaries are still refused. HTML-parsing a JPEG just produces confident nonsense.

---

## Searching the web

```ts
const found = await crawler.search('rochester summer concert series');
if (found.ok) found.results; // [{ title, snippet, url, injectionFiltered? }]

// Restrict it to one site:
await crawler.search('parking', { site: 'venue.example.com' });
```

Usually you don't want URLs, you want what's on them:

```ts
import { searchAndCrawl } from '@oliver/crawl-core';

const found = await searchAndCrawl(crawler, 'summer concert series rochester');
found.pages;    // the pages themselves, already read and cleaned
found.skipped;  // results that couldn't be read, and why
```

Every search result is crawled through the **same guards as any other page**. A search provider is an untrusted source of URLs, and piping those straight into a fetcher is how a search feature turns into a security hole.

Search is the one thing here that always costs money — there's no free search API worth building on — so it needs a key, and it says so plainly when it doesn't have one.

---

## Setup, when you want more

All of this is optional.

```bash
# .env — every line optional
OLIVER_CRAWL_USER_AGENT="MyBot/1.0 (+https://mysite.com/bot)"
OLIVER_CRAWL_LOCAL_RENDER=1     # free JavaScript rendering
OLIVER_CRAWL_AUTO_ROBOTS=1      # check robots.txt automatically
FIRECRAWL_API_KEY=...           # only if you want the paid lane
SERPER_API_KEY=...              # only if you want search
```

```ts
import { createCrawler, configFromEnv } from '@oliver/crawl-core';
const crawler = createCrawler(configFromEnv({ userAgent: 'MyBot/1.0' }));
```

The package has no database of its own, so you wire it to yours:

```ts
createCrawler({
  userAgent: 'MyBot/1.0',
  onUsage: (e) => myMetrics.record(e),        // every external call
  checkBudget: () => spentToday < myCap,      // veto paid calls
  limits: { maxBodyBytes: 5_000_000 },        // raise caps for big pages
});
```

---

## Docs

| | |
|---|---|
| **[ADOPTION.md](docs/ADOPTION.md)** | Putting this in a new project |
| **[EXISTING-PROJECTS.md](docs/EXISTING-PROJECTS.md)** | Adding it to a project you've already built |
| **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** | Diagrams: how a request flows, and why |
| **[LANES.md](docs/LANES.md)** | How the free lane works, rung by rung |
| **[REFERENCE.md](docs/REFERENCE.md)** | Every option and every field you get back |
| **[MIGRATION.md](docs/MIGRATION.md)** | Where the code came from, and what moved |
| **[BACKLOG.md](docs/BACKLOG.md)** | Known gaps — read this before assuming a capability exists |

## Status

432 tests across 31 files, strict TypeScript, builds to `dist/`. A separate live-network suite (`npm run live`, 22 checks) runs the whole thing against real websites, and the package is verified as a genuinely installed dependency. Node 20+. Works on edge and serverless, with local rendering skipped there.

## License

MIT
