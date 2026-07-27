# Adopting oliver-crawl in a new project

> Already running a crawler against real data? Read
> **[EXISTING-PROJECTS.md](EXISTING-PROJECTS.md)** instead. Replacing a live
> system has failure modes this page does not cover.

Integration is one adapter function and a set of callbacks. The library holds no database and knows nothing about your schema, so there is no framework to adopt and nothing to migrate.

## 1. Install

```bash
npm install github:oliver-chase/oliver-crawl#<tag>
```

Pin a tag, never a branch, and never with `^`. Take the newest from `git tag -l` in the package repo. A floating dependency means a change here can alter your crawl behaviour without you doing anything, which is the failure pinning exists to prevent.

ESM-only, Node 20+. A CommonJS repo can import it from an ESM entry point or use dynamic `import()`.

## 2. The adapter

The library takes a `CrawlTarget` — five fields — and returns results. Your own record is almost certainly richer than that. Do not change it; map it:

```ts
import { createCrawler, crawlSite, type CrawlTarget } from '@oliver/crawl-core';

function toCrawlTarget(row: MySourceRow): CrawlTarget {
  return {
    baseUrl: row.url,
    name: row.name,
    robotsPolicy: row.robots ?? 'unknown', // 'unknown' refuses to crawl
    active: row.enabled,
  };
}
```

`robotsPolicy: 'unknown'` fails closed and will not crawl. If your column is nullable, either backfill it or set `autoRobots: true` and let the crawler resolve it. This is the single most common cause of "everything is suddenly blocked".

## 3. The callbacks

Anything the library would need a database for is an injected function instead:

```ts
const crawler = createCrawler({
  userAgent: 'MyApp/1.0 (+https://myapp.example/bot)',

  // Called once per external call. Free rungs report cost 0.
  onUsage: (e) => db.usage.insert({ lane: e.lane, rung: e.rung, cost: e.costUsd, ok: e.ok, ms: e.latencyMs }),

  // Vetoes paid calls. Never consulted for the free path, which cannot spend.
  checkBudget: () => todaySpend() < DAILY_CAP,

  // Only if you want paid fallback at all. Omit for a free-only setup.
  vendor: { firecrawl: process.env.FIRECRAWL_API_KEY },

  localRender: process.env.NODE_ENV !== 'production',
});
```

Include a contact URL in the `userAgent`. A site operator seeing unexplained traffic has no way to ask about it and will block instead; the library warns once if the string carries no contact.

To read keys from the environment instead:

```ts
import { createCrawler, configFromEnv } from '@oliver/crawl-core';
const crawler = createCrawler(configFromEnv({ userAgent: 'MyApp/1.0 (+https://myapp.example/bot)' }));
```

## 4. Crawl

One page:

```ts
const r = await crawler.crawl(toCrawlTarget(row), row.url);
if (r.ok && !r.notModified) useContent(r.pages[0]!.markdown);
```

A site, with the re-crawl loop wired:

```ts
const run = await crawlSite(crawler, toCrawlTarget(row), {
  seeds: row.seedUrls,
  followPagination: true,
  maxPages: 20,
  priorValidators: row.storedValidators,
  priorLastmod: row.storedLastmod,
  onSignals: (id, validators) => db.sources.saveValidators(id, validators),
  targetId: row.id,
});
```

## 5. The re-crawl loop

Scheduled crawling is only affordable if unchanged pages stop costing anything. That requires a round trip through your storage, and it does not happen by itself:

1. A crawl returns `run.validators` (ETag and Last-Modified per URL) and `run.lastmod` (from the sitemap).
2. You store both against the source.
3. The next run passes them back as `priorValidators` and `priorLastmod`.
4. Pages the sitemap reports unchanged are never requested. Pages the server reports unchanged answer 304 and are never downloaded. Both are reported separately from failures.

A weekly-changing site polled hourly settles at roughly one real fetch per week against 167 free checks.

## 6. Finding pages without hardcoding paths

```ts
import { mapSite } from '@oliver/crawl-core';

const map = await mapSite(crawler, target, { maxUrls: 100 });
const run = await crawlSite(crawler, target, { seeds: map.urls });
```

`mapSite` reads the sitemap, the homepage's links, and any feeds the homepage declares — one page body fetched in total. `map.feeds` is worth checking first: a site's own data feed is usually more accurate and more stable than the page rendering it.

## 7. Smoke test

```ts
const health = await crawler.crawl(
  { baseUrl: 'https://example.com', robotsPolicy: 'allow', active: true },
  'https://example.com/',
);
console.assert(health.ok, `crawl smoke test failed: ${health.ok ? '' : health.detail}`);
```

## Runtime notes

- **Node 20+** for the full feature set. On workerd and edge runtimes, local rendering is unavailable and DNS resolution falls back to DNS-over-HTTPS automatically. Everything else is identical.
- **The free path needs no secrets.** A repo can adopt it with nothing configured but a User-Agent.
