# The two fetch paths

Every crawl takes one of two paths, or both in sequence. The split is the library's central design decision, which is why it has its own page.

## The free path (`own`)

Runs on your infrastructure, needs no API key, and costs nothing per call. It is the default, and it is meant to serve the large majority of real pages so the paid path rarely runs at all.

It is a ladder of rungs. Each runs only when the ones above it could not finish the job:

| # | Rung | Cost | What it does |
|---|------|------|--------------|
| 1 | Policy | free | Eligibility, robots posture, same-site, SSRF/DNS-rebinding. Refusals happen **before any content fetch**. With `autoRobots: true` an unknown posture is resolved by really fetching robots.txt — cached per host, so one request per host, never per page |
| 2 | Conditional GET | free | Sends `If-None-Match` / `If-Modified-Since` from stored validators; a 304 ends the crawl with nothing fetched |
| 3 | Fetch | free | Plain HTTPS fetch, real UA, redirects re-validated per hop, body capped at 2 MB |
| 4 | Parse | free | Visible text, title, JSON-LD, same-site links, outbound hosts; SPA payload recovery |
| 5 | Guard | free | Prompt-injection sanitising **before** text is returned |
| 6 | Hash | free | Full-body + content-region digests for change detection |
| 7 | Local render | free | Local headless Chromium (`localRender: true` + `npx playwright install chromium`), for JS-only pages |
| 8 | Remote render | yours | Your own render service (`browserRender`), for deployments that cannot run a browser |
| 9 | Jina Reader | free | Keyless public service; clears bot walls and JS shells the direct fetch can't. `jinaEndpoint` points at your own deployment of their Apache-2.0 build if you would rather not depend on a third party's uptime |
| 10 | Internet Archive | free | **Off by default** (`useArchiveFallback`). Only for a target whose robots posture is explicitly `allow`, and only after every live rung has failed |

### When rungs 7–9 engage

The recovery rungs run on **any** failure of the direct fetch, not just one kind:

- a **network error** (connection reset, DNS failure, timeout)
- an **HTTP status** the fetch can't use — a 403 bot wall, a 429, a 5xx
- **HTML that parsed but had no readable text** — a JavaScript shell

All three take the same path in the same order, and rung 7 runs before rung 9. A 403 is usually a bot wall, and a real browser — with a real TLS fingerprint, real headers and JavaScript execution — clears those where a bare `fetch` does not. Reaching for Jina first would skip infrastructure we control in favour of a third party, and every free rung skipped moves a crawl closer to the paid path.

The ladder is defined in exactly one function (`freeFallbackLadder` in `src/lanes/own/index.ts`) so the order can't drift between the failure paths as rungs are added. `tests/lanes/lane-exhaustion.test.ts` asserts it, including that a vendor is never called while a free rung could still have worked.

One rung is skipped conditionally: **a target carrying `headers` (credentials) never reaches rung 9.** Jina is a public third-party service that fetches the URL itself, so sending it a members-only URL would disclose that URL and its query string to a party you never agreed to share it with — and it would fail regardless, because Jina has none of your credentials. Rungs 7 and 8 still run: those are your own infrastructure.

### The archive rung, and why it is gated

Rung 10 reads the Internet Archive when every live rung has failed. The CDX
API is free and keyless, so it is a genuine free rung rather than another
vendor. The restriction on it is the point:

- **`disallow` — never.** The site said no. Reading an archived copy is still
  reading it.
- **`unknown` — never.** Everything else here fails closed on unknown, and an
  archive is not a way to launder an unresolved posture.
- **`allow` — yes**, once the live rungs are exhausted.
- **A credentialed target — never.** It is not in a public archive, and
  looking would disclose the URL for nothing.

It is last by construction. An archived capture is older than the live page by
definition, so preferring it would serve stale data silently; it runs when the
alternative is nothing at all. `archiveMaxAgeDays` rejects captures beyond an
age you choose.

An archive fallback without these limits is simply a way to read what a site
refused, which would make every other guard here decorative.

## The paid path (`vendor`)

Firecrawl and Apify behind one interface, disabled unless a call passes `lanes: ['own', 'vendor']`. It exists for the pages the free ladder genuinely cannot read — typically those behind commercial anti-bot services, where the differentiator is a residential proxy pool that cannot be replicated for free.

- A missing key disables that rung only; no keys at all reports `no_lane_available` instead of throwing.
- Every paid call is gated on your `checkBudget()` first.
- Vendor output goes through the same prompt-injection guard as our own fetches.

## The rule connecting them

**A policy refusal never escalates.** When the free path refuses a URL as `blocked` or `quarantined`, the crawl ends there rather than falling through to a vendor.

Paying a third party to retrieve what your own guard refused would buy a way around your own controls. A transport failure is a reason to try harder; a policy decision is not.

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
| `adaptiveThrottleMultiplier` (config) | Wait `avgLatency x N` instead of a fixed gap — a slow origin gets more room, floored at `minHostIntervalMs` so it can only ever be MORE polite |
| `cacheTtlMs` (config) | Same URL twice inside the window costs one request |
| `maxDurationMs` (per run) | Wall-clock ceiling. A page budget alone does not bound time — 20 pages at 30s each is a ten-minute run |

A `429`/`503` carrying `Retry-After` is obeyed as stated rather than retried on our own schedule: the origin telling you when to come back is an instruction, and ignoring it is how a crawler gets banned.

`minHostIntervalMs` covers a case `politenessDelayMs` cannot. Many targets can share one host — dozens of tenants on a single CMS, or several sites behind one CDN. Per-run pacing does nothing there: fifty targets would reach that origin simultaneously, and from the origin's side that is indistinguishable from an attack.

## Making re-crawls cheap

Two independent mechanisms, because origins differ:

| Origin sends | Mechanism | Result |
|---|---|---|
| ETag / Last-Modified | Conditional GET | **304 — nothing fetched at all.** Free |
| Nothing (most small sites) | Content hash | Page is fetched, but `unchanged` tells you the meaningful content is identical, so extraction/LLM can be skipped |

Two hashes are stored per page, and the comparison picks the right one:

- **`contentRegionSha256`** — structural, ignores nav/header/footer/script, so a cookie-banner tweak is not a content change. The better signal, but **only computable from HTML**, so it is empty on text-only rungs (Jina, vendor markdown).
- **`textSha256`** — hash of the delivered text. Always present, so always comparable, at the cost of moving when nav text changes.

`unchanged` uses the structural hash only when **both** runs have it, and falls back to the text hash otherwise. Comparing a structural hash against a text hash across a rung change reports a content change that did not happen; that was the defect this design replaced.

Both need the same loop: store `result.validators`, pass them back as `priorValidators`.

## Search is not one of these paths

`crawler.search()` is a separate surface: a query goes in, URLs come out. Its providers are Serper and Tavily, both paid, tried in that order because Serper costs roughly a fifth as much per call.

It shares configuration, budgeting and usage reporting with the fetch paths and nothing else. Notably, results are then crawled through the free path by default — searching does not commit you to paying twice.

---

**See also:** [README](../README.md) · [ARCHITECTURE](ARCHITECTURE.md) — request flow and module map · [REFERENCE](REFERENCE.md) — every option and return field · [BACKLOG](BACKLOG.md) — known gaps
