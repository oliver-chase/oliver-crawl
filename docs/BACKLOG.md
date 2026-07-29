# oliver-crawl — Backlog (open work only)

> **Policy: history lives in git, not here.** An entry leaves this file the day
> its work ships — no archived or DONE sections, no dated log table.
> `git log --follow docs/BACKLOG.md` for what came before; the 44-row shipped/
> fixed/closed tracker this file carried through 2026-07-28 lived there against
> its own stated policy and was removed in the same-day sweep that added this
> note.

Reviewed through: `e6c1bc7` (2026-07-28) — full verify-against-live-code
sweep, per OliverCode's fleet-wide staleness marker
(`core/templates/project/docs/BACKLOG-live-tracker.md`,
`scripts/audit-staleness.py`).

**No open code specs in this library itself.** Everything the 2026-07-27
audit opened has shipped (`docs/DECISIONS.md` has the record). What's below
are real, current open items — none of them a line of code to write in this
repo.

---

## Open — consumer pins are stale, and two of the three carry real fixes they're missing

**Corrected 2026-07-28: this file previously said "one consumer is wired,
two are not." That was wrong.** All three actually wire in and call this
library in live code, confirmed by grep, not by trusting the doc. Consumer
names are deliberately not listed here — this repo is public, its own
consumers are not (see the "make the library generic" decision in
DECISIONS.md and `.private-patterns`, gitignored, enforced by the
pre-commit deleted-repo-name gate) — so the three are labeled by role:

| Consumer | Pin | Commits behind HEAD | Real usage confirmed |
|---|---|---|---|
| the origin app (parity-tested 2026-07-27, see below) | `v0.17.0` | 10 (docs/gate-sync only, no functional gap) | one seam, default-on |
| consumer B | `v0.14.3` | 32 | one shared fetch module + 2 more files |
| consumer C | `v0.14.1` | 36 | one seam |

The two stale pins are missing real, not cosmetic, fixes shipped since:
`RENDER-HOP-2` (a redirect-chain bypass — the guard was present, correct,
and never actually invoked because Chromium follows redirects internally
before the route handler sees them), `RENDER-SUBRESOURCE-1` (page JS could
land a private-address response in the DOM via a subresource fetch),
`ORIGIN-MOVED-1` (a page served past an off-domain refusal wasn't flagged),
`GUARD-PRECISION-4`/`GUARD-PRECISION-5` (quarantine false-positives/negatives
in the injection guard), `THIN-PAGE-1`, `ROBOTS-4XX-1`.

**This is action needed in the CONSUMER repos, not here** — bump the pin,
install, then run `node scripts/parity-check.mjs <urls-file>` against that
consumer's own sources before trusting the swap, per this library's own
stated policy (a silent extraction difference reads as data getting worse,
not as a bug). Tag-not-branch is deliberate (a floating ref would let a
mid-session commit here change a production crawl silently), so this stays
manual, per-consumer, on purpose — not something to automate away.

## Deliberately not doing — validated decisions, not gaps

- **Residential proxies** — assessed, not free-achievable. Lane 2 (paid)
  stays for this.
- **General web search (Serper/Tavily) as a free rung** — free SERP scraping
  is fragile and ToS-grey; would make the package's most security-conscious
  surface its least reliable one. The right lever is reducing DEPENDENCE on
  search (`/map`, sitemap + feed discovery already answer "what pages does
  this site have" without asking a search engine), not faking a free rung.
- **Screenshots** — not planned, no consumer needs it.

---

## Vendor parity — the actual bar

The goal is not "lane 1 runs first." It is **lane 1 making lane 2
unnecessary**. Measured against what the paid APIs actually do — this table
is a living reference, kept current, not a log:

| Vendor capability | Status here | Free-achievable? |
|---|---|---|
| Markdown output, `onlyMainContent` | shipped | Yes |
| `Crawl-delay` compliance | shipped | Yes |
| "Do I even need an LLM?" signal | shipped — vendors do NOT offer this | Yes |
| Whole-site crawl, depth/limits | shipped | Yes |
| Change tracking / caching | shipped (conditional GET + region hash + sitemap lastmod) — better than Firecrawl's `maxAge`: lastmod covers a whole site in ONE request | Yes |
| JS rendering | shipped (local Chromium + own service) | Yes |
| `/map` — fast whole-domain URL discovery | shipped (`mapSite`) | Yes |
| Browser actions (click "load more", scroll, wait) | shipped | Yes |
| Feeds / calendars / CSV / JSON as first-class documents | shipped | Yes |
| PDF parsing | shipped (optional peer) | Yes |
| Consistent polite-client headers (free half of stealth) | shipped — accept-language + full accept; sec-ch-ua deliberately excluded (a half-consistent browser disguise is a stronger tell than none) | Yes |
| Readability-class content scoring for div-soup pages | shipped | Yes |
| Screenshots | not planned — no consumer needs it yet | Yes |
| Residential proxies | not achievable free — lane 2 keeps this | No |
| General web search (Serper/Tavily) | not achievable free — see note above | No |
| Apify actor marketplace | not a capability gap; a different ops model | n/a |

## Where this beats the vendors rather than matching them

A per-call vendor API is stateless, so it cannot carry knowledge from one
page to the next or from one run to the next. Running in-process can. Four
shipped capabilities come from that difference, and none has a vendor
equivalent:

| Capability | What it exploits |
|---|---|
| Sitemap `lastmod` skipping | One request reports which of a site's pages changed; a per-page API must ask per page |
| Per-host rung memory | A host that always rejects the plain fetch is remembered, so the wasted request stops after the first page |
| Content diff | Both versions are held here, so a consumer can re-extract the delta instead of the page |
| Structured-data signal | Reports whether a model is needed at all, which a paid extraction API has no incentive to answer |

## Measured against real sources

Both extractors run over the same 60 random active sources in the origin
app. This was the gate on wiring any consumer, and it was answered
2026-07-27: the origin app's own cheerio runner read 59/60, oliver-crawl
read 60/60, median text-length ratio 0.98 across shared URLs. Re-run
before wiring a new consumer or after a significant change:
`node scripts/parity-check.mjs <urls-file>`, and explain every
disagreement before switching anything over.

---

**See also:** [DECISIONS](DECISIONS.md) — why the code is the way it is · [README](../README.md) · [ARCHITECTURE](ARCHITECTURE.md) · [LANES](LANES.md) · [REFERENCE](REFERENCE.md) · [MIGRATION](MIGRATION.md) — what moved here and what did not
