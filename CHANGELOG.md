# Changelog

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
