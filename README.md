# oliver-crawl

Governed web crawling for TypeScript. Two independent lanes: **our own crawler** (no API keys, no cost) and an optional **vendor lane** (Firecrawl, Apify). Use either. Use both. The free one is the default.

Most scraping libraries give you "URL in, text out". This one also answers *should we have fetched that at all* — SSRF and DNS-rebinding guards, same-site enforcement, robots posture, and prompt-injection sanitising applied **before** page content ever reaches an LLM.

---

## Why two lanes

| | Lane 1: `own` | Lane 2: `vendor` |
|---|---|---|
| **Cost** | Free | Per call, billed by the vendor |
| **Keys needed** | None | One per vendor |
| **Runs on** | Your infrastructure | Theirs |
| **Handles** | HTML, JSON-LD, SPA payloads, conditional GET | JS-heavy pages, hard bot walls |
| **Default?** | Yes | No — opt in explicitly |

The own lane handles the large majority of real pages. The vendor lane exists for the cases it genuinely can't serve — a page that only exists after JavaScript runs, or an origin that blocks direct crawling outright.

**Nothing costs money unless you ask.** `lanes` defaults to `['own']`. A missing vendor key disables that rung and nothing else.

---

## Install

```bash
npm install github:oliver-chase/oliver-crawl
```

## Use

```ts
import { createCrawler, configFromEnv } from '@oliver/crawl-core';

const crawler = createCrawler(configFromEnv({ userAgent: 'MyBot/1.0 (+https://mysite.com/bot)' }));

const result = await crawler.crawl(
  { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow' },
  'https://venue.example.com/events',
);

if (result.ok && !result.notModified) {
  const page = result.pages[0]!;
  page.text;      // sanitised, length-capped visible text — safe to send to an LLM
  page.jsonLd;    // structured data, free and deterministic — no LLM needed
  page.links;     // same-site links, for pagination or detail pages
  page.httpEtag;  // pass back next time to get a free 304
}
```

Failure is a **value, not an exception**:

```ts
if (!result.ok) {
  result.reason;  // 'blocked' | 'unreachable' | 'empty' | 'quarantined' | 'no_lane_available'
  result.detail;  // human-readable explanation
}
```

### Both lanes

```ts
const result = await crawler.crawl(target, url, { lanes: ['own', 'vendor'] });
```

Tries free first; escalates to a paid vendor only if the free lane can't reach the page. A **policy** refusal (off-domain, quarantined) never escalates — paying to route around your own guard is not a fallback.

### Conditional GET — the cheapest crawl is the one that doesn't happen

```ts
const result = await crawler.crawl(target, url, { etag: stored.etag, lastModified: stored.lastModified });
if (result.ok && result.notModified) return; // page unchanged, nothing fetched, nothing parsed
```

---

## Configuration

Explicit, or from the environment. Both work; explicit wins.

```ts
createCrawler({
  userAgent: 'MyBot/1.0 (+https://mysite.com/bot)',   // please set this
  vendor: { firecrawl: process.env.FIRECRAWL_API_KEY },
  onUsage: (event) => metrics.record(event),           // per-call cost/latency
  checkBudget: () => spendToday < dailyCap,            // vetoes paid calls
  dnsLookup: myResolver,                               // optional
});
```

### From `.env` / `.env.local`

`configFromEnv()` reads these. All optional:

```bash
OLIVER_CRAWL_USER_AGENT="MyBot/1.0 (+https://mysite.com/bot)"

# Vendor lane — each enables exactly one rung
OLIVER_CRAWL_FIRECRAWL_KEY=...   # or FIRECRAWL_API_KEY
OLIVER_CRAWL_APIFY_TOKEN=...     # or APIFY_API_TOKEN

OLIVER_CRAWL_VENDOR_ORDER=firecrawl,apify
```

The bare vendor names (`FIRECRAWL_API_KEY`) are accepted as fallbacks, so adopting this package doesn't mean renaming env vars that already work.

```ts
crawler.vendorRungs(); // ['firecrawl'] — what's actually usable right now
```

---

## Design rules

These are why it's reusable across projects rather than welded to one:

1. **No database.** Nothing imports a DB client. State leaves through `onUsage` / `checkBudget` callbacks, so one consumer can write Postgres, another a spreadsheet, another nothing.
2. **No env reads in core.** Config is passed explicitly; `configFromEnv()` is opt-in convenience. You can hold two differently-configured crawlers in one process.
3. **Fail soft across the boundary.** Ordinary failure returns a result. Only programmer error throws.
4. **Every rung optional.** No key means that rung is skipped, never an error.
5. **The guard runs before you see the text.** `page.text` has already been through prompt-injection sanitising.

---

## What the own lane actually does

1. **Policy** — eligibility, same-site, SSRF/DNS-rebinding. Refusals cost no network call.
2. **Conditional GET** — a 304 ends the crawl for free.
3. **Fetch** — real UA; redirects followed manually and **re-validated per hop** (a redirect is attacker-controlled input).
4. **Parse** — visible text, title, JSON-LD, same-site links, outbound hosts; SPA recovery from inline script payloads when the served HTML is a JS shell.
5. **Guard** — prompt-injection sanitising before anything is returned.
6. **Hash** — full-body *and* content-region digests, so a nav/footer tweak doesn't read as a content change.
7. **Jina Reader** — free, keyless last resort for bot-walled or JS-only pages.

Rungs 1-6 need no credentials and cost nothing.

### The SSRF guard

Checking a URL's literal hostname is not enough. An attacker who controls DNS for a host they own can point `totally-normal.example.com` at `127.0.0.1` or `169.254.169.254` (cloud instance metadata). So:

- resolution is checked, not just the hostname
- **every** returned record is checked — a rebinding attack needs only one internal answer in a multi-record reply
- results are cached on **success only**, so a transient resolver failure can't blacklist a real host
- private, loopback, link-local, CGNAT, benchmarking and multicast ranges all refused
- bare-integer hosts (`2130706433` == `127.0.0.1`) refused rather than decoded

Covered by 46 tests.

---

## Development

```bash
npm install
npm run check     # typecheck + tests
npm run build     # emit dist/
```

## Status

Early but substantial. Done, tested (177 tests) and verified against live sites: the own lane, both guards, JSON-LD extraction, conditional GET, lane orchestration, robots.txt fetching/parsing, ICS-feed and pagination discovery, and recipe replay. Still to migrate: the multi-page crawl orchestrator and the browser-render rung — both coupled to the origin app's database, so they need the callback boundary finished first. See docs/MIGRATION.md.

## License

MIT
