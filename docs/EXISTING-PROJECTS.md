# Adding this to a project you've already built

[ADOPTION.md](ADOPTION.md) assumes a clean start. This page is for the harder case: **you already have crawling code, real data, and things that must not break.**

The rule throughout: **add alongside, prove it matches, then delete.** Never swap in place.

---

## 0. First, check it can even run here

Five minutes, before you plan anything.

```ts
// scratch file — throw it away after
import { createCrawler } from '@oliver/crawl-core';
const crawler = createCrawler({ userAgent: 'MyApp/1.0 (+https://myapp.com/bot)' });
const r = await crawler.crawl(
  { baseUrl: 'https://example.com', robotsPolicy: 'allow' },
  'https://example.com/',
);
console.log(r.ok ? 'works here' : r.detail);
```

If that fails, the answer is in [Environment gotchas](#environment-gotchas) below — solve it now, not after you've rewritten call sites.

---

## 1. Map your existing shape onto `CrawlTarget`

You almost certainly have a richer record than this package wants — a database row with 20 columns. Do not change it. Write one adapter:

```ts
function toCrawlTarget(row: MySourceRow): CrawlTarget {
  return {
    baseUrl: row.url,
    name: row.name,
    robotsPolicy: row.robots_policy ?? 'unknown',  // see the warning below
    active: row.enabled,
  };
}
```

> **Watch out:** `robotsPolicy: 'unknown'` **refuses to crawl** (fail-closed). If your existing table has nulls, every one of those targets stops working the moment you switch. Either backfill the column, or set `autoRobots: true` so the crawler resolves it itself.
>
> This is the single most likely cause of "it worked before and now everything is blocked."

---

## 2. Run it beside your current crawler and compare

Do not replace anything yet. Run both, diff the output, on your real targets:

```ts
for (const row of await db.sources.sample(50)) {
  const mine = await myExistingCrawler(row.url);
  const theirs = await crawler.crawl(toCrawlTarget(row), row.url);

  if (theirs.ok !== Boolean(mine)) {
    console.log('DISAGREEMENT', row.url, theirs.ok ? 'new-only' : theirs.detail);
  }
}
```

Expect disagreements. Most will be one of these, and all are informative:

| Disagreement | Usually means |
|---|---|
| New one refuses, old one worked | Fail-closed robots, or a same-site rule your old crawler didn't enforce |
| New one gets less text | Your old one had a higher/absent text cap — raise `maxTextChars` |
| New one gets more | Your old one was truncating and you didn't know |
| New one is `quarantined` | The page really does contain injection-shaped text. Your old crawler was handing that to your LLM |

Only when you understand every disagreement should you switch.

---

## 3. Keep your own persistence — wire the callbacks

This package has no database, so nothing conflicts with yours:

```ts
createCrawler({
  userAgent: 'MyApp/1.0',
  onUsage: (e) => db.usage.insert(e),      // your existing metrics table
  checkBudget: () => todaySpend() < CAP,   // your existing budget logic
});
```

If you already track per-source ETags, feed them in and get free 304s from day one:

```ts
const run = await crawlSite(crawler, toCrawlTarget(row), {
  priorValidators: { [row.url]: { etag: row.stored_etag, lastModified: row.stored_last_modified } },
  onSignals: (id, v) => db.sources.saveValidators(id, v),
  targetId: row.id,
});
```

---

## 4. Switch one call site at a time

Order matters. Go least-risky first:

1. **A read-only or admin path** — somewhere a wrong answer is visible but harmless.
2. **One low-traffic scheduled job.** Watch it for a full cycle.
3. **The main ingestion path**, once the above has been quiet.
4. **Delete your old crawler** — only now, and in its own commit so reverting is one step.

---

## 5. Delete carefully

Once your suite passes against the package:

- Remove your old scraper and its provider clients **in a separate commit** from the one that adopted the package.
- Pin the version: `"@oliver/crawl-core": "github:oliver-chase/oliver-crawl#v0.1.0"` — no `^`, so a package change can never silently alter your crawl behaviour.
- Keep your old tests. Point them at the new code. **They are the evidence the swap preserved behaviour** — that is more valuable than the implementation they were written against.

---

## Environment gotchas

**Your repo is CommonJS.** This package is ESM-only. Either import it from an ESM entry point, or use dynamic import:

```js
const { createCrawler } = await import('@oliver/crawl-core');
```

**You deploy to Cloudflare Workers / Vercel Edge.** Works, with two caveats: local Chromium rendering is skipped (no browser available), and DNS resolution uses DNS-over-HTTPS automatically since `node:dns` doesn't exist there. Everything else is identical. Set `browserRender` if you need JS rendering in that environment.

**Your bundler complains about `playwright`.** It shouldn't — the import is deliberately written so bundler tracers cannot see it. If something still tries to resolve it, mark `playwright` external. It is not a dependency of this package.

**The package installs but imports fail.** Make sure you installed a tagged version (`#v0.1.0`). The build runs on install via `prepare`; if your CI uses `--ignore-scripts`, that step is skipped and there is no `dist/`.

**Everything suddenly reports `blocked`.** Almost always fail-closed robots — see the warning in step 1.

---

## What this package will NOT do for you

Being explicit, so you don't discover these mid-migration:

- **It has no database, queue, or scheduler.** It crawls when you call it. Your existing scheduling stays yours.
- **It does not extract your domain objects.** You get clean text, JSON-LD and links. Turning those into events/products/articles is your code — deliberately, because that logic is what makes your app yours.
- **It does not learn extraction rules.** It can *replay* a stored selector recipe; deciding whether a recipe is any good needs your domain's validity rules.
- **It will not bypass a paywall or a login.** No cookie jar, no auth. A page that requires a session is out of scope.
