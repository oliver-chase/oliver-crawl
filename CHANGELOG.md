# Changelog

## Unreleased

Rename
- the project is now OliverCrawl and its repo is `oliver-chase/olivercrawl`, so install from `github:oliver-chase/olivercrawl`. The npm scope `@oliver/crawl-core` is unchanged
- every environment variable starts with `OLIVERCRAWL_` where it started with `OLIVER_CRAWL_`, so rename any you set

Safety
- Markdown links and images are absolute http(s) URLs, and a `javascript:` or private-address target keeps only its label
- with `autoRobots`, robots.txt is judged for each page's own path, so a `Disallow` below the base URL is honored
- every fetch checks its first host before the request, including an IP literal, and the render rung makes every request through the crawler's pinned connection pool
- `safeFetch` keeps a redirect on the starting site when `sameSiteAs` is not given, and refuses any change of port
- the change probe refuses an inactive or robots-disallowed target, a failed render action still runs the origin check, and the title is returned sanitized
- JSON-LD keys are scanned too, and JSON-LD too deep or too large to scan is dropped
- a site's Crawl-delay expires with the robots.txt answer that carried it

Correctness
- a page whose crawl throws is reported as one failure and the rest of the run continues, and a refused target leaves the stored snapshot as it was
- `seeds: []` falls back to the base URL, include and exclude patterns with the `g` flag match every time, and `mapSite` reports truncation only when a URL was dropped
- a reserved header such as `User-Agent` no longer counts as a credential, a thin page or a bot wall records that the origin answered, and a quarantined render is counted once in usage
- a failure is structural only for an `HTTP 404`-style status, so a duration such as "410 ms" no longer retires a source
- `diffContent` compares line by line, so one changed list item or table row is reported alone, and `truncated` says when a reported block was cut
- the content-region hash reads the page's full Markdown, so a changed link or a block boundary changes it; pass the page URL to `computeContentRegionHash` to match a crawled page
- header, nav, footer and aside images are never content images, `rel="next"` and next links with unquoted hrefs are found, and long strings in a script-rendered page are recovered
- a cache hit is a copy, sitemap numeric entities such as `&#038;` are decoded, and the change probe gives no body hash when the body passes its cap
- when /sitemap.xml is missing, sitemap discovery reads the same-site sitemaps robots.txt lists

Cost
- the local render rung shares one Chromium per process, with a fresh context per page, and closes it after 30 seconds idle
- a redirect walk that stops early releases its connection, and a direct fetch has one timeout for the whole walk
- the per-host throttle remembers at most 10,000 hosts

Docs
- `docs/API.md` holds every export, the search surface and the configuration, and REFERENCE keeps the guide
- `closeSharedPool` is exported, and messages and docs name the `OLIVERCRAWL_*` keys
- the decisions ledger has one row per id, and `check-decisions.mjs` fails on a repeated row

## 0.20.0

Safety
- JSON-LD text and image alt text pass the injection guard, and a hostile body is scanned in linear time
- sitemap redirects may not change port, the sitemap body read keeps its timeout, and credentialed URLs are not sent to Jina
- the address checker follows the address, a PDF is read only up to the body cap, and conditional robots postures do not reach the archive
- a dropped response releases its pooled connection, and credentialed targets skip the render rungs

Correctness
- pages keep every container with a real share of the prose, and the change hash reads the same region the markdown reads
- a 304 needs validators, failed probe reads are unknown, structural failures are not retried, resolver outages are transient, and store errors and capped sitemaps are reported
- paths and queries keep their case, encoded query values stay distinct, placeholder API keys are ignored, and gzipped sitemaps are read
- `maxPages` bounds every fetch

Cost
- 404 and 410 skip the live rungs, `crawlSite` returns html only when asked, and the page cache and resolver pools are bounded

Checks
- CI runs the checks on Node 20, 22 and 24, `scripts/check-install.sh` installs the packed package, and the repo carries `docs/CATALOG.md`

## 0.19.0

Speed
- `crawlSite` fetches in parallel on request (`concurrency`, `perHostConcurrency`), and `crawlSites` crawls many origins at once while every host stays polite
- direct fetches share a keep-alive connection pool, one per resolver, and each new connection goes only to an address the crawler approved as public
- a `CrawlStore` keeps a crawl's queue, validators, sitemap dates and recrawl schedule, so any worker can continue it and unchanged pages are skipped
- `npm run bench` crawls and recrawls six local hosts and fails the check when requests or bytes grow

Accuracy
- extraction is scored on a fixed corpus of saved pages inside `npm run check`
- pages return their main content with comment sections dropped, and near-duplicate pages are reported in `run.duplicates`
- every crawl reports per-host attempts, failures, block rate and latency, and usage events carry the host
- `proxyFetch` lets a blocked host retry through a proxy you run before any third party sees the request

Safety
- the prompt-injection guard scans in linear time, covers image alt text, and a PDF is read only up to the body cap
- the address checker follows the address, and a conditional robots posture no longer reaches the archive rung
- a dropped response releases its pooled connection

Correctness
- paths and queries keep their case in the dedup key
- `maxPages` bounds every fetch, including failures and near-duplicates
- a sitemap entry that redirects keeps its stored date, and a remembered rung that fails no longer runs the ladder twice

Checks
- CI runs the checks on Node 20, 22 and 24 and installs the packed package into an empty project

## 0.18.0

Safety
- IPv4-mapped, NAT64, 6to4 and Teredo IPv6 forms of private addresses are refused, along with `localhost.`
- sitemap and pagination fetches follow only same-site redirects, resolve each hop publicly and use the caller's resolver and user agent
- every network read stops at its byte cap while streaming
- the DNS safe-host verdict expires after 60 seconds
- Jina accepts only public https targets, and the Apify token travels in a header

Correctness
- the page cache keys on credentials, output options and user agent
- changed long pages report as changed; Markdown keeps inline runs, blockquotes, nested lists, several articles and form-wrapped pages
- resumed crawls count collected pages toward `maxPages`; structural failures are not retried; robots rules see the query string and match agents exactly

Removed from the public API
- ICS feed discovery (`discoverIcsFeed` and helpers), the schema.org event and address readers, recipe replay, the detail-link picker, the rung-memory helpers and `sameUrlResource`

The git history was squashed at 0.18.0 and earlier tags were removed. Pin the newest tag.
