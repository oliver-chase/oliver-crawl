# The two lanes

Every crawl in this package goes through one or both of two lanes. The split is the package's core design decision, so it gets its own page.

## Lane 1: `own` — our crawler

Runs on **your** infrastructure with **no API keys and no per-call cost**. This is the default lane, and the goal is that it serves the overwhelming majority of real pages so the paid lane almost never runs.

Its rung ladder, in order — each rung only runs when the ones above it couldn't finish the job:

| # | Rung | Cost | What it does |
|---|------|------|--------------|
| 1 | Policy | free | Eligibility, robots posture, same-site, SSRF/DNS-rebinding. Refusals happen **before any content fetch**. With `autoRobots: true` an unknown posture is resolved by really fetching robots.txt — cached per host, so one request per host, never per page |
| 2 | Conditional GET | free | Sends `If-None-Match` / `If-Modified-Since` from stored validators; a 304 ends the crawl with nothing fetched |
| 3 | Fetch | free | Plain HTTPS fetch, real UA, redirects re-validated per hop, body capped at 2 MB |
| 4 | Parse | free | Visible text, title, JSON-LD, same-site links, outbound hosts; SPA payload recovery |
| 5 | Guard | free | Prompt-injection sanitising **before** text is returned |
| 6 | Hash | free | Full-body + content-region digests for change detection |
| 7 | Local render | free | Local headless Chromium (`localRender: true` + `npx playwright install chromium`), for JS-only pages |
| 8 | Remote render | yours | Your own render service (`browserRender` config) — for serverless deployments that can't run a browser |
| 9 | Jina Reader | free | Keyless public service; clears bot walls and JS shells the direct fetch can't |

## Lane 2: `vendor` — third-party APIs

Firecrawl and Apify behind one interface. **Off by default** — a caller opts in per crawl with `lanes: ['own', 'vendor']`. Exists for the residue: pages the entire own ladder genuinely cannot read.

- A missing key disables that rung only; no keys at all reports `no_lane_available` instead of throwing.
- Every paid call is gated on your `checkBudget()` first.
- Vendor output goes through the same prompt-injection guard as our own fetches.

## The rule that connects them

**A policy refusal never escalates.** If the own lane refuses a URL as `blocked` or `quarantined`, the crawl ends — it does not fall through to a vendor. Paying a third party to fetch what your own guard refused is buying a way around your own security.

## Deciding what to crawl

Given one URL, the lane fetches **one page**. Three switches widen that, and they compose:

| Switch | Finds | Bounded by |
|---|---|---|
| `followLinks` | Every page reachable by same-site links, breadth-first | `maxDepth` (default 2), `maxPages` |
| `useSitemap` | Whatever `/sitemap.xml` lists | `maxPages` |
| `followPagination` | "Next page" links only | `maxPages` |

Breadth-first is deliberate: the pages a site links from its homepage are the ones it considers important, so a run that hits `maxPages` keeps the useful pages instead of descending one deep branch. Pagination stays at the *same* depth as the page it came from — page 2 of a listing is not further from the seed than page 1.

Everything already seen is skipped, including URLs that redirect to a page already fetched, so a site whose nav links every page to every other page terminates instead of looping.

## Not hammering the origin

| Setting | Scope |
|---|---|
| `politenessDelayMs` (per run) | Gap between pages within one `crawlSite` call |
| `minHostIntervalMs` (config) | Gap between requests to one HOST, process-wide and across concurrent callers |
| `cacheTtlMs` (config) | Same URL twice inside the window costs one request |

The second matters more than it looks: many targets can share a host (a city's venues on one CMS, several sites behind one CDN). Per-run politeness does nothing there — fifty targets would hit that origin at once.

## Making re-crawls cheap

Two independent mechanisms, because origins differ:

| Origin sends | Mechanism | Result |
|---|---|---|
| ETag / Last-Modified | Conditional GET | **304 — nothing fetched at all.** Free |
| Nothing (most small sites) | Content hash | Page is fetched, but `unchanged` tells you the meaningful content is identical, so extraction/LLM can be skipped |

Two hashes are stored per page, and the comparison picks the right one:

- **`contentRegionSha256`** — structural, ignores nav/header/footer/script, so a cookie-banner tweak is not a content change. The better signal, but **only computable from HTML**, so it is empty on text-only rungs (Jina, vendor markdown).
- **`textSha256`** — hash of the delivered text. Always present, so always comparable, at the cost of moving when nav text changes.

`unchanged` uses the structural hash only when **both** runs have it, and falls back to the text hash otherwise. Comparing a structural hash against a text hash across a rung change would report a false content change — which is exactly the bug this design replaced.

Both need the same loop: store `result.validators`, pass them back as `priorValidators`.

## Search is not a lane

`crawler.search()` is a separate surface (query in, URLs out) with its own providers (Serper, Tavily — both paid, tried in that order because Serper is ~5x cheaper per call). It shares config, budgeting and usage reporting with the lanes, and nothing else. See the README's Search section.
