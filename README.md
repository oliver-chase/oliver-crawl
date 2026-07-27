# oliver-crawl

**Read web pages, for free, without getting your crawler owned.**

Two ways to fetch a page:

- **Lane 1 — your own crawler.** No accounts, no API keys, no per-page cost.
- **Lane 2 — paid APIs** (Firecrawl, Apify). Off unless you ask.

Lane 1 handles the large majority of real pages. Lane 2 is for the residue.

---

## Try it in 30 seconds

```bash
npm install github:oliver-chase/oliver-crawl
```

```ts
import { createCrawler } from '@oliver/crawl-core';

const crawler = createCrawler({ userAgent: 'MyBot/1.0 (+https://mysite.com/bot)' });

const result = await crawler.crawl(
  { baseUrl: 'https://example.com', robotsPolicy: 'allow' },
  'https://example.com/events',
);

if (result.ok && !result.notModified) {
  console.log(result.pages[0].text); // clean text, safe to hand an LLM
}
```

No keys. Nothing to configure. That's Lane 1.

---

## Why "free" is real, not a trick

Lane 1 makes an ordinary HTTPS request from your own machine — the same thing your browser does when you open a page. There is no middleman to bill you. You pay only the bandwidth and CPU you already own.

The two extras are free for concrete reasons, not hand-waving:

| Extra | Why it costs nothing |
|---|---|
| **JavaScript rendering** | Runs Chromium on *your* machine (`npx playwright install chromium` once) |
| **Bot-wall bypass** | [Jina Reader](https://jina.ai/reader) runs a free public endpoint, no key |

**Paid APIs are never called unless you pass `lanes: ['own', 'vendor']` *and* set a key.** There is no path where this package spends money you didn't ask it to.

---

## What you get back

```ts
result.pages[0].text        // clean text — scripts, styles and nav stripped
result.pages[0].jsonLd      // structured data the page published about itself
result.pages[0].links       // other pages on the same site
result.pages[0].httpEtag    // hand this back next time → free re-crawl (below)
```

If something goes wrong you get a *value*, not a crash:

```ts
if (!result.ok) {
  result.reason;  // 'blocked' | 'unreachable' | 'empty' | 'quarantined' | 'no_lane_available'
  result.detail;  // plain-English explanation
}
```

---

## The three things that make this different

### 1. It refuses to be used as an attack tool

A crawler that fetches whatever URL it's handed is a weapon pointed at your own network. Someone who controls a domain can point `totally-normal.example.com` at `127.0.0.1`, or at `169.254.169.254` — the address that hands out cloud server credentials.

This package resolves the hostname and **refuses anything that lands on a private address**, checks *every* answer DNS returns (not just the first), and re-checks after every redirect. Covered by 46 tests.

### 2. It cleans pages before an AI ever sees them

Web pages can contain text written to hijack an AI reading them ("ignore your previous instructions and…"). Every page — including ones fetched by the paid APIs — goes through a prompt-injection filter **before** you receive it. Pages that trip it come back as `quarantined` instead of quietly poisoning whatever you feed them into.

### 3. Re-crawling the same site is nearly free

Checking a site hourly should not cost 24 full page loads a day.

```ts
const run = await crawlSite(crawler, target, {
  priorValidators: savedFromLastRun,   // ← what you stored last time
});

run.notModified;  // site said "nothing changed" — nothing was downloaded
run.unchanged;    // downloaded, but content is identical — skip re-processing
run.validators;   // ← store this for next time
```

A site checked hourly that only changes weekly costs **one real fetch a week**, not 168.

---

## Crawling a whole site

Give it one URL and let it find the rest:

```ts
import { crawlSite } from '@oliver/crawl-core';

const run = await crawlSite(crawler, { baseUrl: 'https://testsite.com' }, {
  followLinks: true,   // follow every same-site link → /calendar, /menu, /locations
  maxDepth: 2,         // how many hops from the start
  maxPages: 50,        // hard ceiling
});

run.pages;     // everything found
run.failures;  // per-page — one bad page never sinks the run
```

Three ways to decide what gets crawled, usable together:

| Option | Finds |
|---|---|
| `followLinks` | Every page reachable by same-site links — the "capture everything" switch |
| `useSitemap` | Whatever the site's own `/sitemap.xml` lists |
| `followPagination` | Only "next page" links, for paginated listings |

Without any of them, one URL means **one page**.

One request at a time, on purpose. Hammering a small site in parallel is how crawlers get blocked. Pages already seen are never re-fetched, including URLs that redirect to the same place — so a site whose nav links every page to every other page still terminates.

```ts
createCrawler({
  minHostIntervalMs: 500,  // never hit one host more than twice a second
  cacheTtlMs: 60_000,      // same URL twice in a minute = one request
});
```

---

## Searching the web

```ts
const found = await crawler.search('rochester summer concert series');
if (found.ok) found.results; // [{ title, snippet, url }]
```

Search always costs money (there is no free search API), so it needs a key and tells you plainly when it doesn't have one.

---

## Setup, when you want more

Everything below is optional.

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

Hook it to your own systems — the package has no database of its own:

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
| **[ADOPTION.md](docs/ADOPTION.md)** | Put this in a new project |
| **[EXISTING-PROJECTS.md](docs/EXISTING-PROJECTS.md)** | Add it to a project you've already built |
| **[LANES.md](docs/LANES.md)** | How the free lane works, rung by rung |
| **[REFERENCE.md](docs/REFERENCE.md)** | Every option and return field |
| **[MIGRATION.md](docs/MIGRATION.md)** | Where the code came from, what moved |

## Status

262 tests, strict TypeScript, builds to `dist/`. Verified against live sites and as a real installed dependency. Node 20+; works on edge/serverless with local rendering skipped.

## License

MIT
