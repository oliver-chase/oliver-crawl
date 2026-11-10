# Changelog

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

The git history was squashed at this release and earlier tags were removed. Pin `v0.18.0`.
