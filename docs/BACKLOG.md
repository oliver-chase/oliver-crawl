# oliver-crawl — Backlog (open work only)

> **Policy: history lives in git, not here.** An entry leaves this file the day
> its work ships — no archived or DONE sections. `git log --follow docs/BACKLOG.md`
> for what came before.

Opened 2026-07-27 from a full security / QA / functionality audit of the
package against Fallow, the repo it was extracted from. Fallow has ~78
ingestion modules; roughly 20 were migrated. Everything below is a capability
that exists there (or should exist here) and does **not** exist here yet.

Each entry is a **spec, not a build**. Nothing below has been implemented.

---

## CRAWL-FEED-1 — the package can discover a feed it cannot read

**Priority: highest. This is a half-capability, not a missing feature.**

`fetch/feed-discovery.ts` finds ICS calendar feeds — its own header argues they
are "MORE accurate and more stable" than scraping the HTML, which is the whole
reason it exists. But the fetch rung accepts only:

```
/text\/html|application\/xhtml|text\/plain/i     src/lanes/own/index.ts:271
```

`text/calendar` is refused as `reason: 'empty'`. So the package will happily
tell a caller "here is the ICS feed for this site" and then be unable to fetch
it. The most accurate data source we can find is the one we cannot read.

Same gap for `text/csv` (Fallow has `lib/ingestion/csv-parser.ts`, an RFC4180
parser with quoted-comma and embedded-newline handling) and for JSON feeds.

**Spec.** Widen accepted content-types and return the body as a typed payload
rather than forcing everything through HTML parsing:

- add `text/calendar`, `text/csv`, `application/json`, `application/rss+xml`,
  `application/atom+xml`
- add `CrawlPage.contentKind: 'html' | 'calendar' | 'csv' | 'json' | 'feed'`
- parsing ICS into events stays with the CALLER (domain logic), but the raw
  decoded body must reach them — today it does not
- the injection guard still runs: a feed is untrusted text like any other

**Watch out:** widening content-types must not widen what the SSRF and
same-site guards allow. This is a body-handling change only.

---

## CRAWL-VISION-1 — pages whose content is a single image

Municipal and venue pages routinely publish the real detail — dates, lineup,
time, address, parking — inside one poster/flyer image, with almost nothing in
the page text. Fallow documents the canonical case (Perinton "Center Stage
Concert Series") in `lib/ingestion/page-image-flyer.ts`.

Today oliver-crawl parses such a page, finds no meaningful text, runs the whole
free ladder, and returns `unreachable`. The content was there the entire time.

**Spec.** Split it along the same line as every other lane boundary:

- **ours (free, generic):** identify the likely content image(s) on a page —
  largest in the content region, not in nav/header/footer, not a logo/sprite/
  icon, plausible poster aspect ratio. Return them as
  `CrawlPage.candidateContentImages: string[]`.
- **caller's (paid):** running a vision model over those URLs. Fallow's
  `vision-extraction.ts` does this with an ordered model list and per-model
  usage logging; that is its business, not the package's.

Shipping only the free half is the right first step and is genuinely useful on
its own — a caller can then decide whether an image is worth paying to read.

---

## CRAWL-CONTENTKIND-1 — extraction version stamping

Fallow has `lib/ingestion/extraction-version.ts`. oliver-crawl can *replay* a
stored recipe (`applyRecipe`) but stamps nothing on its output, so a consumer
holding a stored page has no way to answer "was this extracted by an older,
worse version — should I re-run it?"

Without this, improving the extractor has no mechanism to reprocess everything
it would now do better. The improvement only ever applies to pages crawled
after it shipped.

**Spec.** Add `CrawlPage.extractorVersion: string`, bumped on any change to
text/link/JSON-LD extraction, and document the re-crawl contract: a consumer
compares stored version against `EXTRACTOR_VERSION` and re-processes what is
behind. Cheap to add, and impossible to add retroactively with any value.

---

## CRAWL-CONCURRENCY-1 — cross-host parallelism

`crawlSite` is strictly sequential. Correct for politeness *within* one host,
but crawling 50 unrelated hosts serially is 50× slower than it needs to be for
no benefit to anyone.

`core/host-throttle.ts` already enforces per-host pacing process-wide and
across concurrent callers (it reserves the slot before awaiting, specifically
so concurrent callers serialise). So the per-host safety property that makes
this risky is **already solved** — this is mostly wiring.

**Spec.** `crawlSite(..., { concurrency: n })`, default 1 so nothing changes
silently. Never parallelise within a host; the throttle would serialise it
anyway, so the only effect would be to hold connections open. Cap by distinct
host, not by URL.

---

## CRAWL-SESSION-1 — no session continuity for credentialed crawls

A caller can pass `headers` (including a Cookie), and those are correctly sent
only to the target's own host. But there is no cookie jar: a login that sets a
session cookie on the first response cannot carry it to page two.

That makes multi-page members-area crawling impossible even though single-page
credentialed crawling works — a sharp edge that is currently undocumented.

**Spec.** Either implement a per-crawl (never global) cookie jar scoped to the
target host, or document the limitation explicitly in EXISTING-PROJECTS.md.
Documenting is the honest short-term answer and costs nothing.

**Watch out:** a cookie jar is a credential store. It must never outlive one
crawl, never be shared between targets, and never follow a redirect off-host.

---

## CRAWL-DETAILLINK-1 — choosing which link to follow for a missing field

Fallow's `lib/ingestion/detail-link-picker.ts` answers "which of this page's
links plausibly carries a still-null field" from `{label, url}` pairs. The
mechanism is generic; only its keyword table is domain-specific.

`PageLink` here already carries `{ url, text }`, so the input exists.

**Spec.** A generic scorer taking caller-supplied keyword groups and returning
ranked candidates. Ships the mechanism, keeps the domain vocabulary with the
caller — the same split used everywhere else in this package.

---

## CRAWL-PARITY-1 — extraction parity with Fallow's cheerio runner is unverified

Fallow's `secure-crawlee-runner.ts` (515 lines) extracts with cheerio.
oliver-crawl uses its own parser. **Nobody has compared their output on the
same pages.** The migration assumed parity and never demonstrated it.

This matters before Fallow is wired to consume the package: a silent extraction
regression across every source is the exact failure this repo exists to avoid,
and it would look like a data-quality drift rather than a code bug.

**Spec.** A differential harness — run N real Fallow source URLs through both,
diff text length, title, link count, JSON-LD node count. Every disagreement
gets explained before any swap. `docs/EXISTING-PROJECTS.md` already prescribes
exactly this procedure for consumers; the package has not run it on itself.

---

## CRAWL-UA-1 — no contact URL in the user agent goes unflagged

`userAgent` is required but unvalidated. A UA with no contact URL is a
significant cause of being blocked — a site operator seeing unexplained traffic
has no way to reach you, so they block. Fallow derives its UA from
`FALLOW_APP_ORIGIN` for exactly this reason (`lib/ingestion/user-agent.ts`,
WHITE-LABEL-1).

**Spec.** Warn once (never throw) when `userAgent` contains no `http(s)://` or
`+`-prefixed contact. Document the convention in ADOPTION.md. Deliberately not
an error: a caller may have a legitimate reason, and breaking their crawl over
a style rule would be worse than the problem.

---

## CRAWL-DEGRADE-1 — no notion of a source degrading over time

The package reports per-crawl outcomes. It has no concept of "this source has
failed six runs in a row and needs attention." Fallow builds that on top
(`source-autofix.ts`, `source-recover.ts`, `refresh-failure.ts`).

Most of that is rightly the consumer's — it needs a database. But the package
currently gives a consumer no *shape* to build against, so every consumer
re-invents failure classification from raw `reason` strings.

**Spec.** Classify failures as `transient` (timeout, 5xx, DNS blip) vs
`structural` (404, robots disallow, dead host) on the result. That single bit
is what a consumer needs to decide "retry" vs "tell a human", and only the
package has the context to judge it correctly.

---

## Live tracker

| Date | Entry | Change |
|---|---|---|
| 2026-07-27 | file created | Nine specs opened from the post-extraction audit against Fallow. None implemented. |
