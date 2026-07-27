# Adopting oliver-crawl in a repo

The goal: any of your repos can crawl with a few lines, reuse the same guards and lane logic, and never reimplement providers again. This is the how.

## 1. Install

```bash
npm install github:oliver-chase/oliver-crawl
```

ESM-only, Node 20+. If your repo is CommonJS, import it from an ESM entry point or use dynamic `import()`.

## 2. The one adapter you write

The package deliberately does **not** know your database. You give it a `CrawlTarget` (5 fields) and it hands back results; you persist what you want. That adapter is the whole integration.

```ts
import { createCrawler, crawlSite, type CrawlTarget } from '@oliver/crawl-core';

// Your record -> the package's minimal shape. This is the only glue.
function toCrawlTarget(row: MySourceRow): CrawlTarget {
  return {
    baseUrl: row.url,
    name: row.name,
    robotsPolicy: row.robots ?? 'unknown', // 'unknown' fails closed
    active: row.enabled,
  };
}
```

## 3. Wire the callbacks to your systems

Everything the package would otherwise need a database for is an injected function. Give it yours:

```ts
const crawler = createCrawler({
  userAgent: 'MyApp/1.0 (+https://myapp.example/bot)',

  // Your metrics/usage table — called once per external call.
  onUsage: (e) => db.usage.insert({ lane: e.lane, rung: e.rung, cost: e.costUsd, ok: e.ok, ms: e.latencyMs }),

  // Your daily budget — vetoes paid calls. Own-lane rungs are free and never ask.
  checkBudget: () => todaySpend() < DAILY_CAP,

  // Vendor keys, if you want the paid lane at all. Omit for free-only.
  vendor: { firecrawl: process.env.FIRECRAWL_API_KEY },

  // Free JS rendering on machines that can run a browser.
  localRender: process.env.NODE_ENV !== 'production',
});
```

Or, the shortcut for the common case — read keys from the environment:

```ts
import { createCrawler, configFromEnv } from '@oliver/crawl-core';
const crawler = createCrawler(configFromEnv({ userAgent: 'MyApp/1.0 (+https://myapp.example/bot)' }));
```

## 4. Crawl

Single page:

```ts
const r = await crawler.crawl(toCrawlTarget(row), row.url);
if (r.ok && !r.notModified) useText(r.pages[0]!.text);
```

Whole site, with re-crawl efficiency:

```ts
const run = await crawlSite(crawler, toCrawlTarget(row), {
  seeds: row.seedUrls,
  followPagination: true,
  maxPages: 20,
  // Feed back what you stored last time -> unchanged pages cost a free 304.
  priorValidators: row.storedValidators,
  // Persist this run's fresh validators for next time.
  onSignals: (id, validators) => db.sources.saveValidators(id, validators),
  targetId: row.id,
});
```

## 5. The re-crawl efficiency loop (the point of scheduled crawling)

This is what makes repeated crawls cheap:

1. First crawl returns `result.validators` — ETag / Last-Modified per URL.
2. You store them against the source.
3. Next scheduled run, pass them as `priorValidators`.
4. Unchanged pages answer **304** — the crawl fetches nothing, parses nothing, costs nothing, and reports them under `notModified`.

A site checked hourly that changes weekly then costs one real fetch per week and 167 free 304s. That is the free re-crawl goal, and it needs the store-and-replay loop above wired — it does not happen on its own.

## 6. Discovering what to crawl (free)

Instead of hardcoding seed paths:

```ts
import { discoverSitemapUrls } from '@oliver/crawl-core';

const found = await discoverSitemapUrls(target, { userAgent: crawler-ua, maxUrls: 100 });
const run = await crawlSite(crawler, target, { seeds: found.urls });
```

## 7. Verify it works

```ts
const health = await crawler.crawl(
  { baseUrl: 'https://example.com', robotsPolicy: 'allow', active: true },
  'https://example.com/',
);
console.assert(health.ok, 'crawl smoke test failed');
```

## Runtime notes

- **Node 20+ for the full feature set.** On workerd/edge, local render is skipped (no browser) and DNS resolution falls back to DNS-over-HTTPS automatically — everything else works.
- **The own lane needs no secrets.** A repo can adopt the free lane with zero configuration beyond a User-Agent.
- **Pin the version** (`"@oliver/crawl-core": "github:oliver-chase/oliver-crawl#v0.1.0"`) so a package change never silently alters your crawl behaviour.
