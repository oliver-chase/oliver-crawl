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
- Pin the version: `"@oliver/crawl-core": "github:oliver-chase/oliver-crawl#v0.2.0"` — no `^`, so a package change can never silently alter your crawl behaviour.
- Keep your old tests. Point them at the new code. **They are the evidence the swap preserved behaviour** — that is more valuable than the implementation they were written against.

---

## How updates reach your repos (deliberately not automatic)

This package is a **pinned dependency, not a fork**. One codebase; every
consumer pins a tag:

```json
"@oliver/crawl-core": "github:oliver-chase/oliver-crawl#v0.2.0"
```

Editing oliver-crawl changes **nothing** in any consumer until that consumer
bumps its pin. That is the feature: an unpinned dependency means a package
change silently alters crawl behaviour across every repo at once, which is
exactly the failure pinning exists to prevent.

The flow, end to end:

1. **In oliver-crawl:** land the change, `npm run check` green, tag —
   `git tag v0.2.1 && git push origin v0.2.1`.
2. **In each consumer, when ready:** bump the pin in package.json,
   `npm install`, run THAT repo's suite. The suite is what proves the update
   is safe for that repo — each consumer adopts on its own schedule.
3. **Rollback is the same move backwards:** re-pin the previous tag.

Working on both at once (developing a package change against a real
consumer): `npm link` in oliver-crawl, `npm link @oliver/crawl-core` in the
consumer — live coupling until you unlink. Never ship the link.

## Adopting a narrow slice (you don't have to take everything)

The package is one import, but adoption doesn't have to be all-or-nothing. A
repo whose only crawl surface is, say, link-resolution plus search-enrichment
can replace exactly that and touch nothing else:

```ts
// One narrow call site swapped, the rest of the app untouched.
const found = await searchAndCrawl(crawler, `${name} details`, { maxResults: 2 });
```

The comparison discipline in step 2 above still applies to the slice you
swap. Everything you did not swap keeps running as it always has — there is
no framework to buy into, no init, no global state shared with the rest of
your app beyond the per-host politeness throttle.

---

## Environment gotchas

**Your repo is CommonJS.** This package is ESM-only. Either import it from an ESM entry point, or use dynamic import:

```js
const { createCrawler } = await import('@oliver/crawl-core');
```

**You deploy to Cloudflare Workers / Vercel Edge.** Works, with two caveats: local Chromium rendering is skipped (no browser available), and DNS resolution uses DNS-over-HTTPS automatically since `node:dns` doesn't exist there. Everything else is identical. Set `browserRender` if you need JS rendering in that environment.

**Your bundler complains about `playwright`.** It shouldn't — the import is deliberately written so bundler tracers cannot see it. If something still tries to resolve it, mark `playwright` external. It is not a dependency of this package.

**The package installs but imports fail.** Make sure you installed a tagged version (`#v0.2.0`). The build runs on install via `prepare`; if your CI uses `--ignore-scripts`, that step is skipped and there is no `dist/`.

**Everything suddenly reports `blocked`.** Almost always fail-closed robots — see the warning in step 1.

---

## What you have to wire yourself

None of these are things the package should do for you — but you do need to know they're your job, and roughly what the wiring looks like.

### Scheduling — yours

The package crawls when called. It has no scheduler, queue or cron. Whatever you already use stays:

```ts
// your existing cron / worker / queue consumer
for (const row of await db.sources.due()) {
  const run = await crawlSite(crawler, toCrawlTarget(row), {
    priorValidators: row.validators,
    onSignals: (id, v) => db.sources.saveValidators(id, v),
    targetId: row.id,
  });
  await db.pages.upsert(run.pages);
}
```

### Turning pages into YOUR objects — yours

You get `text`, `jsonLd`, `links`, `title`. Turning those into events, products or articles is your code, deliberately: that logic is what makes your app yours, and a generic version of it would be wrong for everyone.

Start with `jsonLd` before reaching for an LLM — many sites publish structured data describing themselves, and reading it is free and exact:

```ts
for (const node of page.jsonLd) {
  if (node['@type'] === 'Event') myEvents.push(fromJsonLd(node)); // free, no LLM
}
if (myEvents.length === 0) myEvents = await myLlmExtract(page.text); // paid fallback
```

### Storing crawl state — yours, and the package hands you exactly what to store

```ts
run.validators;  // { [url]: { etag, lastModified, bodySha256, contentRegionSha256, textSha256 } }
```

Persist that blob against the source; pass it back as `priorValidators` next run. That single round-trip is what makes re-crawls nearly free.

### Pages behind a login — yours to authorise, ours to fetch

The package will not acquire, store or refresh credentials. It **will** send ones you already hold:

```ts
crawler.crawl(
  { baseUrl: 'https://partner.example.com', robotsPolicy: 'allow',
    headers: { authorization: `Bearer ${await myTokenStore.get()}` } },
  'https://partner.example.com/members/calendar',
);
```

Sent only to that target's own host — the same-site rule means a redirect cannot walk your token to another origin.

Setting `headers` also **disables the Jina fallback rung for that target**. Jina is a public service that fetches the URL on your behalf, so a members-only URL would be disclosed to a third party, and the fetch would fail anyway without your token. Local and remote rendering still run, because those are your own infrastructure. If a credentialed page is JS-rendered, configure `localRender` or `browserRender` — the Jina rung is not available to catch it.

### Learning extraction recipes — yours

The package can *replay* a stored selector recipe (`applyRecipe`). Deciding whether a recipe is any good requires your domain's validity rules ("did the dates parse", "is that a real venue name"), so learning stays with you.
