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
