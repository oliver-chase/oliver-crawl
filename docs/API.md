# API

Every export, the search surface and the configuration. [REFERENCE](REFERENCE.md) shows them in use.

## Exports

Everything the package exports, grouped by what you would reach for it to do.
`src/index.ts` is the full list; the groups below cover what most callers reach for.

### Crawling

| Export | Purpose |
|---|---|
| `createCrawler(config)` | The crawler. Everything else takes one. Its methods: `crawl`, `search`, `discoverSeeds` and `discoverSeedEntries` (sitemap URLs, with dates), `resolveTarget` (fills an unknown robots posture when `autoRobots` is on), `vendorRungs` and `searchProviders` (what your keys enable) |
| `crawlSite(crawler, target, options)` | Multi-page crawl: seeds, discovery, budgets, resume |
| `crawlSites(crawler, targets, options)` | Many sites at once, each polite to its own host |
| `createMemoryCrawlStore()` | The default `CrawlStore`; implement `CrawlStore` to keep a crawl's state elsewhere |
| `mapSite(crawler, target, options)` | URLs a site has, without crawling them |
| `searchSite(crawler, target, query)` | Search **within** a site using its own search — free |
| `searchAndCrawl(crawler, query, options)` | Web search, then read the results |
| `searchWeb(query, config, options)` | Web search only (paid) |

### Reading a result

| Export | Purpose |
|---|---|
| `summarizeStructuredData(jsonLd)` | Is any of this JSON-LD about the page's content? |
| `diffContent(previous, current)` | What changed between two versions — re-extract the delta |
| `findContentImages($, pageUrl)` | Images that plausibly carry the content (flyers, posters) |
| `classifyFailure(reason, detail)` | `transient` (retry) vs `structural` (needs a fix) |
| `looksLikeEmptyState(text)` | "No results" pages that cost a model call to learn nothing |
| `looksLikeBlockPage(text)` | A bot-wall interstitial wearing an HTTP 200 |
| `EXTRACTOR_VERSION` | Bump signal: re-process pages stored by an older extractor |

### Change detection

| Export | Purpose |
|---|---|
| `await computeContentRegionHash(html, pageUrl?)` | Hash of the page's Markdown, nav/footer-insensitive. Pass the page URL to match `contentRegionSha256` |
| `probeCheapChangeSignal` · `cheapSignalsMatch` | Cheap pre-fetch change probe |
| `urlDedupKey(url)` | Canonical URL identity |

### Discovery

| Export | Purpose |
|---|---|
| `discoverSitemapUrls(target, options)` | Sitemap entries, with `lastmod` |
| `findNextPageUrl` · `discoverPaginatedUrls` | Pagination |

### Fetch rungs

| Export | Purpose |
|---|---|
| `isLocalRenderAvailable()` | Whether `playwright` can be loaded here |
| `MAX_ACTIONS` · `MAX_ACTION_TOTAL_MS` | The `browserActions` limits: 10 actions and 20 seconds in all |
| `renderViaLocalChromium(url, enabled, actions?, dnsLookup?, onBlocked?)` | Local browser render, with optional `browserActions`; `onBlocked` hears a security refusal |
| `renderViaService` · `renderServiceFrom` | Your own render service |
| `fetchViaWayback(url, options)` | Internet Archive capture — free, gated (see [LANES](LANES.md)) |
| `extractPdfText(bytes)` | PDF text layer, via the optional `unpdf` package |
| `classifyContentType` · `refineKindByUrl` | What kind of document is this |
| `safeFetch` | Fetch with the host guards applied |

### Policy and safety

| Export | Purpose |
|---|---|
| `sanitizeCrawledText` · `detectPromptInjectionSignals` | The injection guard |
| `evaluateRobotsForUrl` · `parseRobots` · `userAgentToken` | robots.txt |
| `assertTargetEligible` · `assertRequestUrlAllowed` · `assertRedirectUrlAllowed` · `assertRedirectUrlAllowedForHost` | Same-site and eligibility |
| `assertHostResolvesToPublicAddress` · `assertPublicHost` · `isSafeHttpUrl` | SSRF screening |
| `createDohLookup` · `DEFAULT_DOH_ENDPOINT` | DNS-over-HTTPS, for runtimes without `node:dns` |
| `publishedCrawlDelayMs(host)` · `MAX_HONORED_CRAWL_DELAY_MS` | The site's own `Crawl-delay` |

### Configuration and state

| Export | Purpose |
|---|---|
| `configFromEnv(env, overrides)` · `resolveConfig(config)` | Config helpers |
| `availableVendorRungs` · `availableSearchProviders` | Which paid rungs your keys enable |
| `DEFAULT_*` constants | Defaults, for callers who want to reason about them |
| `closeSharedPool()` | Closes the pooled connections, for a long-lived host that is shutting down |

### Options worth knowing

| Config | Effect |
|---|---|
| `store` · `recrawlMinIntervalMs` · `recrawlMaxIntervalMs` · `storeIntervalMs` | Keep crawl state in a `CrawlStore`, with a recrawl wait from one hour to seven days and saves one second apart ([LANES](LANES.md#making-re-crawls-cheap)) |
| `autoRobots` | Resolve an unknown robots posture by fetching robots.txt. **Required** for `crawlSite` on targets with no stored `robotsPolicy`, which otherwise fail closed |
| `localRender` | Free local Chromium rung |
| `browserActions` | Click/scroll/wait before capture, on the local render rung |
| `jinaEndpoint` | Point the reader rung at your own Apache-2.0 deployment in place of the public one |
| `renderWhenTextBelow` | Escalate to render when a page parsed but is implausibly short — a JS page shipping only nav and footer otherwise reads as a success |
| `useArchiveFallback` · `archiveMaxAgeDays` | Internet Archive rung — off by default, `allow` posture only |
| `rungMemory` | Remember which rung works per host (default on) |
| `proxyFetch` | A `fetch` that routes through your own proxy, tried after a block and before Jina |
| `cacheTtlMs` · `minHostIntervalMs` · `adaptiveThrottleMultiplier` | Repeat-request and politeness controls |
| `dohEndpoint` | The DNS-over-HTTPS resolver used when no `dnsLookup` is given |
| `vendorRungOrder` | The order the paid vendor rungs are tried in |
| `includeHtml` (crawl option) | Keep the raw HTML on the returned page; `crawlSite` returns pages without it unless you ask |
| `retries` (crawl option) | Extra attempts for one `crawl()` call. Permanent (structural) failures are not retried |
| `maxRetries` · `retryBackoffMs` (site option) | Retries per URL in `crawlSite` and the base wait between them |
| `includePatterns` · `excludePatterns` (site option) | Regexes that allow or skip discovered URLs |
| `storeKey` (site option) | The key a crawl's state is kept under in its `CrawlStore` |
| `sitemapOnly` (`mapSite` option) | Map from the sitemap alone and skip the homepage |
| `site` · `searchOnly` (`searchAndCrawl` option) | Restrict a search to one domain, or return results without reading them |

## Search

Query in, URLs out — a different surface from crawling, and always paid.

```ts
const found = await crawler.search('industrial flow meter suppliers', { maxResults: 5 });

if (found.ok) {
  found.results;   // [{ title, snippet, url, injectionFiltered? }]
  found.provider;  // which one answered
} else {
  found.reason;    // 'no_provider_configured' | 'no_results' | 'budget_refused' | 'error'
}
```

A search provider is untrusted on both counts, so results are filtered before you see them:

- **`url`** — anything that is not a safe public `http(s)` URL is dropped. A `javascript:` href would be an XSS in your UI; a private-network URL would be an SSRF in your fetcher
- **`title` / `snippet`** — run through the same prompt-injection guard as crawled page text. A snippet is usually the target page's own meta description, so it is attacker-influenceable prose, and these strings are the ones people feed to a model. When the guard trips, both fields come back empty with **`injectionFiltered: true`**, and the `url` is still returned — it is validated separately and still worth crawling

Check `injectionFiltered` if you display snippets; an empty snippet on a real URL is otherwise puzzling, and the flag is itself a useful signal about the page behind it.

Returns an outcome object on purpose: an empty array cannot tell you whether the web had nothing, your key was missing, or your budget said no. Serper is tried before Tavily by default. Provider results are filtered through the same URL-safety check as extracted links, so a `javascript:` or private-host result never reaches you.

---

## Configuration

Explicit, or from the environment. Both work; explicit wins.

```ts
createCrawler({
  userAgent: 'MyBot/1.0 (+https://mysite.example/bot)',   // please set this
  vendor: { firecrawl: process.env.FIRECRAWL_API_KEY },
  onUsage: (event) => metrics.record(event),           // per-call cost/latency
  checkBudget: () => spendToday < dailyCap,            // vetoes paid calls
  dnsLookup: myResolver,                               // optional
});
```

### From `.env` / `.env.local`

`configFromEnv()` reads the variables [`.env.example`](../.env.example) lists, all optional. Each key has an `OLIVERCRAWL_` name, and the bare vendor names such as `FIRECRAWL_API_KEY` are read as fallbacks, so env vars that already work keep working.

```ts
crawler.vendorRungs(); // ['firecrawl'] — what's actually usable right now
```
