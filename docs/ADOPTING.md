# Adopting olivercrawl

Integration is one adapter function and a set of callbacks. The library holds no database and knows nothing about your schema, so there is no framework to adopt and nothing to migrate. This guide covers a new project, replacing a crawler you already run, what you wire yourself, and the failures you will hit, listed by what you see.

## Install

```bash
npm install github:oliver-chase/olivercrawl#<tag>
```

Pin a tag and leave off the `^`. Find the newest with `git ls-remote --tags --sort=-v:refname https://github.com/oliver-chase/olivercrawl.git | head -1`. A floating dependency lets a change here alter your crawl behavior without you doing anything.

The package is ESM-only and needs Node 20 or newer. A CommonJS repo imports it from an ESM entry point or with dynamic `import()`. The build runs on install through `prepare`, so a CI that uses `--ignore-scripts` ends up with no `dist/` to import.

## The adapter

`CrawlTarget` has the fields `baseUrl`, `name`, `robotsPolicy`, `active`, `seeds` and `headers`. Your own record is almost certainly richer. Leave it alone and map it:

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

`robotsPolicy: 'unknown'` fails closed and does not crawl. A nullable column therefore blocks every target with a null the moment you switch. Backfill it, or set `autoRobots: true` and let the crawler fetch and evaluate robots.txt itself, cached per host. A robots.txt that answers 4xx other than 429 permits crawling, as RFC 9309 says; a 5xx or a network failure still fails closed.

## The callbacks

Anything the library would need a database for is an injected function:

```ts
const crawler = createCrawler({
  userAgent: 'MyApp/1.0 (+https://myapp.example/bot)',
  onUsage: (e) => db.usage.insert({ lane: e.lane, rung: e.rung, cost: e.costUsd, ok: e.ok, ms: e.latencyMs }),
  checkBudget: () => todaySpend() < DAILY_CAP,       // vetoes paid calls only
  vendor: { firecrawl: process.env.FIRECRAWL_API_KEY }, // omit for a free-only setup
  localRender: process.env.NODE_ENV !== 'production',
});
```

Put a contact URL in the `userAgent`, because a site operator who sees unexplained traffic blocks it. The library warns once if the string carries no contact. `configFromEnv()` reads the same options from `OLIVERCRAWL_*` variables (see `.env.example`). The free path needs no secrets.

## Crawl

```ts
const r = await crawler.crawl(toCrawlTarget(row), row.url);
if (r.ok && !r.notModified) useContent(r.pages[0]!.markdown);

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

To find pages without hardcoding paths, `mapSite(crawler, target)` reads the sitemap, the homepage links and any feeds the homepage declares, with one page body fetched. Check `map.feeds` first, since a site's own data feed is usually more accurate than the page that renders it.

## The re-crawl loop

A `CrawlStore` over your storage keeps the validators, the sitemap dates and the recrawl schedule between runs:

```ts
const store: CrawlStore = { load: (key) => db.get(key), save: (key, state) => db.put(key, state) };
await crawlSite(crawler, target, { useSitemap: true, store });
```

Unchanged pages cost nothing: the sitemap skips them, or the server answers 304. [LANES](LANES.md#making-re-crawls-cheap) explains the mechanisms and [REFERENCE](REFERENCE.md#keeping-a-crawls-state-in-a-store) lists the options. Callers that keep their own storage can pass `priorValidators` and `priorLastmod` instead.

## Replacing a crawler you already run

The rule is to add alongside, prove it matches, then delete. Check first that it runs in your environment: crawl `https://example.com/` from a scratch file and print `r.detail` on failure.

**Compare on real targets.** Run both crawlers over a sample and diff the output:

```ts
for (const row of await db.sources.sample(50)) {
  const mine = await myExistingCrawler(row.url);
  const theirs = await crawler.crawl(toCrawlTarget(row), row.url);
  if (theirs.ok !== Boolean(mine)) console.log('DISAGREEMENT', row.url, theirs.ok ? 'new-only' : theirs.detail);
}
```

| Disagreement | Usually means |
|---|---|
| New one refuses, old one worked | Fail-closed robots, or a same-site rule your old crawler lacked |
| New one gets less text | Your old crawler had a higher or absent cap, so raise `maxTextChars` |
| New one gets more | Your old crawler was truncating |
| New one is `quarantined` | The page contains injection-shaped text that your old crawler handed to your model |

`node node_modules/@oliver/crawl-core/scripts/parity-check.mjs my-urls.txt --json` prints counts and hashes per URL, which diff far better than full text.

**Switch one call site at a time.** Start with a read-only or admin path, then one low-traffic scheduled job for a full cycle, then the main ingestion path. Delete the old crawler last, in its own commit so a revert is one step, and keep your old tests pointed at the new code as the evidence that behavior held.

**Keep your own persistence.** Per-source ETags you already store go into `priorValidators` and give free 304s from the first run.

## What you wire yourself

- **Scheduling.** The package crawls when called and has no scheduler, queue or cron. Call `crawlSite` from whatever you already use
- **Turning pages into your objects.** You get `text`, `markdown`, `jsonLd`, `links` and `title`, and the mapping to your records stays in your code. Read `jsonLd` before reaching for a model, since it is free and exact
- **Crawl state.** `run.validators` holds `{ etag, lastModified, bodySha256, contentRegionSha256, textSha256 }` per URL. Persist it and pass it back next run
- **Pages behind a login.** The package sends credentials you hold and never acquires, stores or refreshes them (example below)

```ts
crawler.crawl(
  { baseUrl: 'https://partner.example.com', robotsPolicy: 'allow', headers: { authorization: `Bearer ${await tokenStore.get()}` } },
  'https://partner.example.com/members/calendar',
);
```

Headers go only to that target's own host, so a redirect cannot carry your token to another origin. There is no cookie jar: a `Set-Cookie` is not replayed, so a login that sets a session on request one cannot carry it to request two. Acquire the session yourself and pass the cookie in `headers`. Setting `headers` also disables the Jina rung for that target, because Jina would receive a members-only URL. Local and remote rendering still run.

## Updates are pinned

Editing olivercrawl changes nothing in a consumer until that consumer bumps its pin. To release, land the change with `npm run check` green and run `git tag vX.Y.Z && git push origin vX.Y.Z`. In each consumer, bump the pin, run that repo's suite, and roll back by re-pinning the previous tag. To develop a package change against a real consumer, use `npm link` and never ship the link.

## Troubleshooting

**Everything reports `blocked`.** A robots posture never resolved. See the adapter section: backfill `robotsPolicy` or set `autoRobots: true`.

**`crawlSite` returns zero pages but a single crawl works.** `crawlSite` checks eligibility once before any lane runs, so an unresolved `robotsPolicy` ends the run with one failure and no pages. The fix is the same.

**Imports fail after install.** Install a tagged version and let `prepare` build (see Install).

**The bundler complains about `playwright`.** The import is hidden from bundler tracers on purpose, and `playwright` is not a dependency. If something still resolves it, mark it external. Local rendering needs `npm install playwright` and `npx playwright install chromium`.

**A PDF returns `Unsupported content-type` or names a missing package.** PDF support needs the optional `unpdf` package (`npm install unpdf`). Without it, PDFs fail with `failureClass: 'structural'`, and a retry will not help. A scanned PDF with no text layer also fails structurally and needs a vision model.

**Pages come back thin.** Check three causes in order. The page may be JavaScript-rendered, in which case set `renderWhenTextBelow` and enable `localRender`. You may be reading `text`, which holds every visible word, when `markdown` holds the main content with structure. And the rung that served it may return prose, so `links`, `jsonLd` and `contentRegionSha256` are empty by design. Check `page.rung`.

**A page comes back `quarantined`.** The prompt-injection guard found instructions aimed at whatever model reads the page, and withheld it. A page that quotes an injection payload in an article trips the same patterns. `result.quarantine.signals` names the rules that fired and the text that matched, and `result.quarantine.text` is the sanitized page, so you can open a review task. A rule that fires on ordinary copy is a bug to report.

**Search returns `no_provider_configured`.** `crawler.search()` needs `SERPER_API_KEY` or `TAVILY_API_KEY`. To search within a known site, `searchSite` submits to the site's own search form and is free.

**Crawls are slower than expected.** Requests go out one at a time per host and honor any published `Crawl-delay`. `adaptiveThrottleMultiplier` gives a slow origin more room. `searchAndCrawl` accepts a `concurrency` option across hosts.

**Edge and serverless.** Local Chromium is unavailable there, so set `browserRender` to your own rendering service. DNS resolution uses DNS-over-HTTPS on every runtime by default, and a name that only your network resolves needs your own `dnsLookup`.
