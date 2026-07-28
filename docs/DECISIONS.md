# Decision records

Every `ID-N` referenced in the source has an entry here. `scripts/check-decisions.mjs`
fails the build if a decision in the code is missing from this file, if an entry
here describes code that no longer exists, or if a test invents an ID.

**Why this file exists.** About 40% of non-blank lines in `src/` are comments,
and most of them explain a decision by naming the defect it prevents. That is
only durable if the records stay honest — otherwise a refactor quietly undoes a
decision, or an entry outlives the code it described and becomes confidently
wrong.

**Where the detail lives.** The source comment carries the full reasoning, next
to the code it governs. This file is the index: one line each, plus where to
look. Measurements from a specific run belong in [BACKLOG](BACKLOG.md)'s tracker
with their date, never restated here — a number in two places is wrong the
moment one changes.

| ID | What it protects | Source | Test |
|---|---|---|---|
| `BETTER-DIFF-1` | Report what changed, not just that it did, so a consumer re-extracts the delta rather than the page. | `extract/content-diff.ts` | `extract/backlog-batch.test.ts` |
| `BETTER-LASTMOD-1` | A sitemap answers "which pages changed" in one request; conditional GET costs one request per page. Skip-only, because lastmod frequently lies. | `crawl-site.ts` | `fetch/sitemap-lastmod.test.ts` |
| `BETTER-RUNGMEMORY-1` | Remember the rung that works per host. Store is PER CRAWLER — a module-level one leaks between crawlers with different identities. | `core/config.ts` | `core/rung-memory.test.ts` |
| `BETTER-SOFT404-1` | Flag pages that loaded and say nothing. Advisory only: an empty state is often a true fact worth recording. | `core/soft-404.ts` | `core/consumer-signals.test.ts` |
| `CACHE-POLICY-1` | The page cache is keyed on url+lanes, not the target, so policy must run BEFORE the cache read or a second target reads what it was refused. | `index.ts` | `lanes/cache-policy.test.ts` |
| `CI-NODE20-1` | Cross-runtime SHA-256 without assuming a Node-only API. | `core/hash.ts` | — |
| `CRAWL-BACKOFF-1` | Obey Retry-After as stated. Our own schedule is a guess; the origin's is an instruction. | `crawl-site.ts` | — |
| `CRAWL-CONCURRENCY-1` | Parallelism is safe in searchAndCrawl only because host-throttle already serialises per host. Default 1. | `search-and-crawl.ts` | — |
| `CRAWL-CONTENTKIND-1` | Stamp extractorVersion so an extraction improvement can reach pages already stored. Cannot be added retroactively. | `core/extractor-version.ts` | `core/consumer-signals.test.ts` |
| `CRAWL-DEDUP-1` | Dedup on the RESOLVED url too — /home, /index and / commonly converge. | `crawl-site.ts` | `lanes/crawl-site.test.ts` |
| `CRAWL-DEGRADE-1` | failureClass separates "retry later" from "needs a human". The useful distinction is not in `reason`. | `core/failure-class.ts` | `core/consumer-signals.test.ts` |
| `CRAWL-DETAILLINK-1` | Rank links against caller-supplied keywords. Mechanism is generic; vocabulary is the caller's domain. | `extract/detail-link-picker.ts` | `extract/backlog-batch.test.ts` |
| `CRAWL-FEED-1` | Read feeds, calendars, CSV and JSON. We discovered ICS feeds we could not then fetch. | `core/content-kind.ts` | `lanes/content-kinds.test.ts` |
| `CRAWL-HARDEN-1` | Cap body bytes. An endless response otherwise ties up memory until the process dies. | `lanes/own/index.ts` | `lanes/own-lane.test.ts` |
| `CRAWL-HASH-1` | Compare like with like. A structural hash against a text hash across a rung change reports a change that did not happen. | `core/types.ts` | `lanes/crawl-site.test.ts` |
| `CRAWL-PDF-1` | PDF parser is an OPTIONAL peer — a large hostile-input surface does not belong in every consumer's install. | `core/content-kind.ts` | `fetch/pdf-extract.test.ts` |
| `CRAWL-PERF-1` | Parse the document once, not once per JSON-LD script tag. | `fetch/build-page.ts` | — |
| `CRAWL-RESUME-1` | Emit a snapshot after each page so a killed run continues. Package stores nothing. | `crawl-site.ts` | `lanes/crawl-resume.test.ts` |
| `CRAWL-ROBOTS-1` | robots.txt was ported but never called. A governed crawler was only as governed as the caller's bookkeeping. | `lanes/own/index.ts` | `lanes/own-lane.test.ts` |
| `CRAWL-UA-1` | Warn once when a User-Agent carries no contact. Operators block traffic they cannot ask about. | `core/config.ts` | `core/consumer-signals.test.ts` |
| `CRAWL-UNCHANGED-1` | Hashes were computed and discarded. Comparing them is what makes re-crawls cheap for origins sending no ETag. | `crawl-site.ts` | `lanes/crawl-site.test.ts` |
| `CRAWL-VALIDATE-1` | Conditional-GET headers were never actually sent; the test passed on a stub that returned 304 unconditionally. | `fetch/http-mechanics.ts` | `lanes/own-lane.test.ts` |
| `CRAWL-VISION-1` | Rank images that plausibly carry the content. Finding them is free and ours; reading them is the caller's. | `core/types.ts` | `extract/backlog-batch.test.ts` |
| `CRAWLSITE-AUTOROBOTS-1` | crawlSite checked eligibility before robots could resolve, so autoRobots did nothing for whole-site crawls. | `crawl-site.ts` | `lanes/crawlsite-autorobots.test.ts` |
| `DEPLOY-BLOCKER-1` | The playwright import is invisible to bundler tracers. A plain import breaks serverless builds for consumers who never wanted it. | `fetch/local-render.ts` | — |
| `GUARD-PRECISION-1` | Guard patterns tightened against real page copy that was being quarantined. | `guard/prompt-injection-guard.ts` | `guard/guard-precision.test.ts` |
| `GUARD-PRECISION-2` | Same, second pass: a missed attack alongside the false positives. | `guard/prompt-injection-guard.ts` | — |
| `GUARD-TITLE-1` | `<title>` lives in `<head>`, so it was never part of the body text or markdown the guard inspects and shipped raw. A title is page content callers display and feed to models. | `fetch/build-page.ts` | `guard/title-guard.test.ts` |
| `GUARD-PRECISION-3` | encoded-payload spans URL paths because `/` is in its class. URLs are stripped before that rule only. | `guard/prompt-injection-guard.ts` | `guard/guard-precision.test.ts` |
| `HOST-CACHE-SCOPE-1` | A module-level DNS cache shared by every crawler let one crawler's observation answer another's security check. | `core/rung-memory.ts` | `core/rung-memory.test.ts` |
| `JINA-CREDENTIAL-1` | Never send a credentialed target's URL to a public proxy. It discloses the URL and cannot succeed anyway. | `lanes/own/index.ts` | `lanes/lane-exhaustion.test.ts` |
| `JINA-SELFHOST-1` | The reader endpoint is configurable. A rung advertised as free should not depend on one third party's uptime. | `core/types.ts` | — |
| `JSONLD-SIGNAL-1` | Report whether structured data is about the CONTENT. `jsonLd.length > 0` is a misleading test. | `core/types.ts` | `extract/structured-summary.test.ts` |
| `LADDER-QUALITY-1` | A bot-wall interstitial is a rung failure, not content. Accepting it beat the rung holding the real page. | `core/block-page.ts` | `lanes/block-page.test.ts` |
| `LANE-EXHAUST-1` | Every failure path exhausts the free rungs in one order, defined once. A skipped free rung reaches the paid lane sooner. | `lanes/own/index.ts` | `lanes/lane-exhaustion.test.ts` |
| `MARKDOWN-BLOCKLINK-1` | A bare <a> under a container lost its href. Index and results pages produced markdown with no URLs. | `extract/html-to-markdown.ts` | `extract/html-to-markdown.test.ts` |
| `MARKDOWN-DATAURI-1` | Never emit data: image srcs. A base64 placeholder tripped the injection guard and quarantined ordinary pages. | `extract/html-to-markdown.ts` | `extract/html-to-markdown.test.ts` |
| `PDF-TIMEOUT-1` | Parsing is time-bounded. The bytes are attacker-supplied and a hostile PDF can send a parser into work that never finishes; a hang is worse than a failure, because nothing reports and nothing retries. | `fetch/pdf-extract.ts` | `fetch/pdf-extract.test.ts` |
| `PAGE-SHAPE-1` | Every rung returns a complete, self-consistent page, checked against one contract. Written after a refactor dropped `markdown` on the paid lane with 600 tests green — they asserted rungs returned pages, never what was in them. | `fetch/build-page.ts` | `lanes/page-shape.test.ts` |
| `PARITY-ACTIONS-1` | Browser actions before capture, bounded by library constants a caller cannot raise. | `core/types.ts` | `fetch/browser-actions.test.ts` |
| `PARITY-HEADERS-1` | Send a plausible header set. A missing accept-language is an old bot tell; sec-ch-ua is deliberately NOT sent. | `fetch/http-mechanics.ts` | — |
| `PARITY-MAP-1` | List a site's URLs without crawling it. One page body fetched. | `map-site.ts` | `lanes/map-site.test.ts` |
| `PARITY-READABILITY-1` | Paragraphs vote for their parent when no semantic tag exists. Guardrails because a wrong pick loses content. | `extract/html-to-markdown.ts` | `extract/html-to-markdown.test.ts` |
| `READABILITY-CHROME-1` | Scoring ran before chrome removal, so a prose-heavy sidebar could win and the later strip could not undo it. | `extract/html-to-markdown.ts` | `extract/html-to-markdown.test.ts` |
| `RENDER-REDIRECT-1` | page.goto follows the whole redirect chain inside Chromium and the caller builds the page with the URL it ASKED for, so an origin could bounce this rung to a private address and have that content returned under the original URL. The landing host is now re-checked, and again after any browser actions. | `fetch/local-render.ts` | `fetch/render-redirect.test.ts` |
| `ROBOTS-4XX-1` | RFC 9309: a 4xx means robots.txt is UNAVAILABLE and crawling is permitted. 429 excluded. | `fetch/robots-check.ts` | `fetch/robots-check.test.ts` |
| `ROBOTS-DELAY-1` | Honour the site's published Crawl-delay as a floor. Reading robots for permission and ignoring its pacing takes half the file. | `fetch/robots-check.ts` | `fetch/crawl-delay.test.ts` |
| `ROBOTS-REDIRECT-1` | Off-domain robots redirects are FOLLOWED. Refusing them cost six working sources to stop one parked domain. | `fetch/robots-check.ts` | `fetch/robots-redirect.test.ts` |
| `ROBOTS-TTL-1` | The robots cache had no expiry, so a transient failure stalled a host permanently and a new Disallow was never seen. | `lanes/own/index.ts` | `fetch/robots-cache-ttl.test.ts` |
| `SAFEFETCH-PARITY-1` | safeFetch claimed the same discipline as robots-check and cheap-change-probe but accepted any redirect host and took no injectable resolver. Same-site is now enforced when the caller supplies it, and the resolver is threaded like every other fetch path. | `fetch/feed-discovery.ts` | `fetch/safefetch-parity.test.ts` |
| `SEARCH-DIAG-1` | Report every provider's failure. Naming only the last one points at the wrong thing to fix. | `search/index.ts` | `search/search.test.ts` |
| `SEARCH-DIAG-2` | Every provider erroring is an outage, not `no_results`. | `search/index.ts` | `search/search.test.ts` |
| `SEARCH-INJECTION-1` | Guard provider titles and snippets. A snippet is the target page's own meta description. | `search/index.ts` | `search/search.test.ts` |
| `SEARCH-ONSITE-1` | Search a site using its own search. Free, and reaches pages neither links nor a sitemap expose. | `search-site.ts` | `lanes/search-site.test.ts` |
| `THIN-PAGE-1` | Escalate a page that parsed but is implausibly short. A JS page shipping only nav and footer read as a success. | `core/types.ts` | `lanes/thin-page.test.ts` |
| `URL-DEDUP-1` | Dedup on canonical URL identity. Conservative on purpose: a wrong merge loses a page invisibly. | `core/url-dedup-key.ts` | `lanes/url-dedup.test.ts` |
| `VENDOR-PARITY-1` | Markdown is an accuracy lever, not a format preference. Structure the author encoded survives. | `core/types.ts` | `extract/html-to-markdown.test.ts` |
| `VENDOR-POLICY-1` | Policy holds for EVERY lane. A vendor-only crawl previously ran entirely unvetted. | `index.ts` | `lanes/vendor-policy-gate.test.ts` |
| `WAYBACK-RUNG-1` | Archive fallback, gated to an explicit `allow` posture only. Ungated it is a way to read what a site refused. | `core/types.ts` | `fetch/archive-rung.test.ts` |
| `WHITE-LABEL-2` | User-facing strings named another project's bot regardless of the configured agent. | `fetch/robots-check.ts` | `fetch/crawl-delay.test.ts` |
| `QUARANTINE-TELEMETRY-1` | Every rung emits a usage event when it quarantines. A guard nobody can see firing teaches an operator nothing. | `lanes/own/index.ts` | `lanes/lane-exhaustion.test.ts` |
| `OFFDOMAIN-WWW-1` | `www.` and apex are the same site; anything else is not. | `fetch/host-policy.ts` | `fetch/host-policy.test.ts` |
| `PROBE-DNS-SEAM-1` | `probeCheapChangeSignal` takes an injectable `dnsLookup` like every other fetch path, so its success path is testable without real DNS. | `fetch/cheap-change-probe.ts` | `core/public-helpers.test.ts` |

## Decisions with no test

A decision no test names is one refactor from being undone silently.
`check-decisions.mjs` reports these on every run without failing, because
making it fatal would produce hollow tests rather than real ones.

The five that remain are structural, and named here so the gap is a decision
rather than an oversight:

| ID | Why no test |
|---|---|
| `CI-NODE20-1` | A runtime-compatibility choice in the hash helper. Exercised by every test that hashes; nothing to assert beyond "it runs here". |
| `CRAWL-CONCURRENCY-1` | The default is 1, so the concurrent path only exists when a caller opts in. Covered indirectly by the searchAndCrawl suite. |
| `CRAWL-PERF-1` | Parse-once instead of parse-per-script-tag. A behavioural test would assert output that is identical either way; only a profiler shows the difference. |
| `DEPLOY-BLOCKER-1` | The playwright import is written to be invisible to bundler tracers, which also makes it unmockable. Verified by consumers' builds not breaking, not by a unit test. |
| `GUARD-PRECISION-2` | Superseded in practice by `GUARD-PRECISION-3`'s suite, which exercises the same patterns against real page copy. |

