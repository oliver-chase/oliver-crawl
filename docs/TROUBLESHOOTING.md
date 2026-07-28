# Troubleshooting

Failures you will actually hit, listed by what you see rather than by what causes it.

---

## Everything reports `blocked`

Almost always a robots posture that never resolved.

A `CrawlTarget` with no `robotsPolicy` fails closed and will not crawl. If your source records have a nullable robots column, every one of those targets stops the moment you switch.

```ts
createCrawler({ userAgent: 'MyBot/1.0 (+https://mysite.com/bot)', autoRobots: true });
```

`autoRobots` resolves an unknown posture by fetching robots.txt for real, cached per host. Alternatively, backfill the column and pass the stored value — that is faster, since it skips a request per host.

A site returning 4xx on `robots.txt` is treated as *permitting* crawling, per RFC 9309. A 5xx or a network failure still fails closed.

---

## `crawlSite` returns zero pages, but a single-page crawl of the same URL works

The same cause as above, in the one place it is least visible.

`crawlSite` checks target eligibility once, up front, before any lane runs. Without `autoRobots` or a stored `robotsPolicy`, that check refuses the target and the run ends with a single failure and no pages.

---

## Imports fail after installing

Install a **tagged** version, not a bare branch:

```bash
npm install github:oliver-chase/oliver-crawl#<tag>
```

The build runs on install via `prepare`. If your CI uses `--ignore-scripts`, that step is skipped and there is no `dist/` to import.

---

## The bundler complains about `playwright`

It should not. The import is written so bundler tracers cannot see it, because a visible import makes them resolve playwright's own optional dependencies and break the build for consumers who never wanted rendering.

If something still tries to resolve it, mark `playwright` external. It is not a dependency of this package.

---

## A PDF returns `Unsupported content-type` or names a missing package

PDF support needs the optional `unpdf` peer:

```bash
npm install unpdf
```

Without it, PDFs fail with `failureClass: 'structural'` and a message naming the package — retrying will not help until it is installed. A scanned PDF with no text layer also fails structurally: it needs a vision model, not a parser.

---

## Pages come back thinner than expected

Three causes, cheapest to check first.

**The page is JavaScript-rendered.** The HTML arrives with navigation and a footer and nothing else, which passes an is-it-empty check. Set `renderWhenTextBelow` to escalate a page that parsed but is implausibly short, and enable `localRender`.

**You are reading `text` instead of `markdown`.** `text` is every visible word including navigation; `markdown` is the main content region with structure preserved. Feed a model `markdown`.

**The rung that served it produced prose, not HTML.** Check `page.rung`. Jina and the vendor lane return text, so `links`, `jsonLd` and `contentRegionSha256` are empty by design rather than missing.

---

## A page comes back `quarantined`

The prompt-injection guard found instructions aimed at whatever AI reads the page, and the page is withheld rather than returned.

This is not always an attack. A page quoting an injection payload in an article trips the same patterns. Check `result.detail` for which signal fired; if it is a false positive on ordinary copy, that is a bug worth reporting rather than a setting to relax.

---

## Search returns `no_provider_configured`

Web search is the one surface that always costs money. `crawler.search()` needs `SERPER_API_KEY` or `TAVILY_API_KEY`.

To search *within* a site you already know, use `searchSite` instead — it submits to the site's own search form and is free.

---

## Crawls are slower than expected

Requests go out one at a time per host by design, and the library also honours any `Crawl-delay` the site publishes. `adaptiveThrottleMultiplier` gives a slow origin more room, which lowers throughput further but keeps you from being blocked.

For a result set spanning many hosts, `searchAndCrawl` accepts a `concurrency` option. Requests to the same host still serialise.

---

## It runs on your laptop but not on edge or serverless

Local Chromium rendering is unavailable there, and DNS resolution falls back to DNS-over-HTTPS automatically. Everything else is identical.

Set `browserRender` to point at your own rendering service if you need JavaScript execution in that environment.

---

**See also:** [README](../README.md) · [ADOPTING](ADOPTING.md) — first-time setup · [EXISTING-PROJECTS](EXISTING-PROJECTS.md) — replacing a live crawler · [REFERENCE](REFERENCE.md) — every option and field · [BACKLOG](BACKLOG.md) — known gaps
