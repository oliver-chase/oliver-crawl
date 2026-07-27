// ─── Multi-page crawl orchestrator ──────────────────────────────────────────
//
// Drives the single-page crawl across a target's seeds, optionally following
// pagination, and returns one result for the whole run.
//
// Everything here is a LOOP over parts that already exist — policy, fetch,
// render, guard, hashing all live in the lanes. This module owns only the
// things a single page cannot decide for itself:
//
//   - which URLs to visit (seeds, then discovered next-pages)
//   - how many, in total (a hard page budget — a crawl must be bounded)
//   - what to do when one page fails (retry, unless retrying is pointless)
//   - not visiting the same URL twice
//   - reporting per-URL outcomes without letting one bad page sink the run
//
// Sequential, not parallel, and deliberately so: the origin implementation
// this was ported from ran `maxConcurrency: 1`, and hammering a small venue
// site with parallel requests is exactly the behaviour that gets a crawler
// blocked. Politeness is a feature.

import { assertRequestUrlAllowed, assertTargetEligible } from './fetch/host-policy.js';
import { findNextPageUrl } from './extract/pagination-discovery.js';
import type { Crawler } from './index.js';
import type { CrawlOptions, CrawlPage, CrawlTarget } from './core/types.js';

export type SiteCrawlOptions = CrawlOptions & {
  /** URLs to start from. Falls back to target.seeds, then target.baseUrl. */
  seeds?: string[];
  /** Hard ceiling on pages fetched in one run, seeds included. */
  maxPages?: number;
  /** Attempts per URL before giving up on it. 0 = try once, never retry. */
  maxRetries?: number;
  /** Follow "next page" links discovered on crawled pages, up to maxPages. */
  followPagination?: boolean;
  /** Per-URL conditional-GET validators from a previous run, keyed by URL —
   *  exactly the shape `result.validators` (and `config.onSignals`) hands
   *  back, so the round-trip is: crawl → persist → pass here next run. */
  priorValidators?: Record<
    string,
    { etag?: string | null; lastModified?: string | null; contentRegionSha256?: string }
  >;
  /** Pause between page fetches, ms. Sequential is already the default;
   *  this adds breathing room for small origins. 0 = none. */
  politenessDelayMs?: number;
  /** Consumer id for this target, passed to onSignals so the consumer knows
   *  which of its records the validators belong to. Defaults to baseUrl. */
  targetId?: string;
  /** Discover seeds from the site's own /sitemap.xml when no seeds were
   *  given. Free, and far more accurate than guessing paths — the site is
   *  telling you what it has. Falls back to baseUrl if there is no sitemap. */
  useSitemap?: boolean;

  /** Persistence hook for this run's fresh validators — same data as
   *  `result.validators`, delivered as a callback for consumers that prefer
   *  push over return-value plumbing. Fire-and-forget: a throwing sink never
   *  breaks the crawl. */
  onSignals?: (targetId: string, validators: SiteCrawlResult['validators']) => void | Promise<void>;
  /** Base wait between retry attempts (multiplied by attempt number).
   *  Exists mostly so tests can zero it. */
  retryBackoffMs?: number;
};

export type SiteCrawlFailure = { url: string; reason: string; detail: string };

export type SiteCrawlResult = {
  /** Pages successfully fetched and parsed. */
  pages: CrawlPage[];
  /** URLs the origin answered 304 for — unchanged, and correctly NOT failures. */
  notModified: string[];
  /** Per-URL failures. A run with some pages and some failures is normal. */
  failures: SiteCrawlFailure[];
  /** True when the run stopped because it hit maxPages rather than running
   *  out of URLs — the caller may want to raise the budget or paginate again. */
  truncated: boolean;
  /** Fresh conditional-GET validators per URL from THIS run. Persist these
   *  and pass them back as `priorValidators` next run — that round-trip is
   *  what turns a scheduled re-crawl of an unchanged page into a free 304.
   *  Also delivered via onSignals when set. `contentRegionSha256` is the
   *  nav/footer-INSENSITIVE hash: it answers "did the real content change"
   *  for the many origins that send no ETag at all. */
  validators: Record<
    string,
    { etag: string | null; lastModified: string | null; bodySha256: string; contentRegionSha256: string }
  >;
  /** URLs that WERE re-fetched (the origin gave no 304) but whose meaningful
   *  content is byte-identical to last run, by content-region hash. A
   *  consumer can skip re-extraction/re-LLM for these — the fetch was
   *  unavoidable, the expensive downstream work is not. */
  unchanged: string[];
  startedAt: string;
  finishedAt: string;
};

const DEFAULT_MAX_PAGES = 5;
const DEFAULT_MAX_RETRIES = 1;

/**
 * A failure that retrying cannot fix. Retrying a blocked URL just burns the
 * budget to get the identical refusal — the origin implementation made the
 * same distinction with its TerminalCrawlError.
 */
function isTerminal(reason: string): boolean {
  return reason === 'blocked' || reason === 'quarantined' || reason === 'no_lane_available';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Crawl a target across its seeds.
 *
 * Takes a `Crawler` rather than a config so lane selection, budgeting and
 * usage reporting all come along for free — this orchestrator never needs to
 * know which lane served a page.
 */
export async function crawlSite(
  crawler: Crawler,
  target: CrawlTarget,
  options: SiteCrawlOptions = {},
): Promise<SiteCrawlResult> {
  const startedAt = new Date().toISOString();
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);

  const pages: CrawlPage[] = [];
  const notModified: string[] = [];
  const failures: SiteCrawlFailure[] = [];
  const validators: SiteCrawlResult['validators'] = {};
  const unchanged: string[] = [];

  const done = (truncated: boolean): SiteCrawlResult => {
    // Deliver fresh validators to the consumer's persistence hook, fire-and-
    // forget: a slow or throwing sink must not break (or slow) the crawl.
    if (Object.keys(validators).length > 0 && options.onSignals) {
      try {
        void options.onSignals(options.targetId ?? target.baseUrl, validators);
      } catch {
        // deliberately swallowed
      }
    }
    return { pages, notModified, failures, truncated, validators, unchanged, startedAt, finishedAt: new Date().toISOString() };
  };

  // Eligibility is a property of the TARGET, not of any one URL — check it
  // once, and report it as a single failure rather than N identical ones.
  try {
    assertTargetEligible(target);
  } catch (error) {
    failures.push({
      url: target.baseUrl,
      reason: 'blocked',
      detail: error instanceof Error ? error.message : String(error),
    });
    return done(false);
  }

  // Seeds: explicit list, else the base URL. Each is validated same-site up
  // front so a bad seed is reported as itself rather than surfacing later as
  // a confusing mid-run failure.
  let rawSeeds = options.seeds ?? target.seeds;
  if (!rawSeeds && options.useSitemap) {
    // Free page discovery: the site's own sitemap beats guessing paths.
    // Goes through the crawler so it uses the SAME User-Agent and DNS
    // resolver as every other request — a discovery call that resolved DNS
    // differently from the crawl would be both inconsistent and, in tests,
    // an unstubbed network call.
    const discovered = await crawler.discoverSeeds(target, maxPages);
    if (discovered.length > 0) rawSeeds = discovered;
  }
  rawSeeds = rawSeeds ?? [target.baseUrl];
  const queue: string[] = [];
  for (const seed of rawSeeds) {
    try {
      queue.push(assertRequestUrlAllowed(target, seed).toString());
    } catch (error) {
      failures.push({ url: seed, reason: 'blocked', detail: error instanceof Error ? error.message : String(error) });
    }
  }

  // Dedup across seeds AND discovered pagination — a site whose page 2 links
  // back to page 1 must not loop.
  const visited = new Set<string>();

  while (queue.length > 0) {
    if (pages.length + notModified.length >= maxPages) return done(true);

    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    const prior = options.priorValidators?.[url];
    const perPageOptions: CrawlOptions = {
      ...options,
      etag: prior?.etag ?? options.etag ?? null,
      lastModified: prior?.lastModified ?? options.lastModified ?? null,
      // Pagination discovery reads markup, so the page must carry its HTML.
      // Requested here rather than left to the caller: otherwise
      // followPagination would silently do nothing.
      includeHtml: options.includeHtml || options.followPagination === true,
    };

    let lastFailure: SiteCrawlFailure | null = null;
    let succeeded = false;

    for (let attempt = 0; attempt <= maxRetries && !succeeded; attempt++) {
      const result = await crawler.crawl(target, url, perPageOptions);

      if (result.ok) {
        succeeded = true;
        if (result.notModified) {
          notModified.push(url);
          // The stored validators are still current — carry them forward so
          // the consumer's next run keeps getting free 304s.
          if (prior?.etag || prior?.lastModified) {
            validators[url] = {
              etag: prior.etag ?? null,
              lastModified: prior.lastModified ?? null,
              bodySha256: '',
              contentRegionSha256: prior.contentRegionSha256 ?? '',
            };
          }
          break;
        }
        pages.push(...result.pages);
        for (const p of result.pages) {
          // CRAWL-UNCHANGED-1: the content-region hash was computed on every
          // page and then thrown away. Comparing it against last run's is
          // what makes re-crawls cheap for origins that send NO ETag (most
          // small sites) — the page had to be fetched, but nothing
          // downstream has to re-run.
          const priorRegion = options.priorValidators?.[p.url]?.contentRegionSha256;
          if (priorRegion && priorRegion === p.contentRegionSha256) unchanged.push(p.url);
          validators[p.url] = {
            etag: p.httpEtag,
            lastModified: p.httpLastModified,
            bodySha256: p.bodySha256,
            contentRegionSha256: p.contentRegionSha256,
          };
        }

        // Pagination is discovered from the page we just read, so it can only
        // extend the queue — never re-order what was already scheduled.
        if (options.followPagination && result.pages[0]?.html) {
          const next = findNextPageUrl(result.pages[0].html, url);
          if (next) {
            try {
              const safeNext = assertRequestUrlAllowed(target, next).toString();
              if (!visited.has(safeNext)) queue.push(safeNext);
            } catch {
              // An off-site "next" link is not an error — just not ours to follow.
            }
          }
        }
        break;
      }

      lastFailure = { url, reason: result.reason, detail: result.detail };
      // Retrying these produces the identical answer; spend the budget elsewhere.
      if (isTerminal(result.reason)) break;
      // Back off before the retry — an origin that just failed usually needs
      // a moment, and an immediate re-hit reads as hostile.
      if (attempt < maxRetries) await sleep((options.retryBackoffMs ?? 500) * (attempt + 1));
    }

    if (!succeeded && lastFailure) failures.push(lastFailure);

    if ((options.politenessDelayMs ?? 0) > 0 && queue.length > 0) {
      await sleep(options.politenessDelayMs!);
    }
  }

  return done(false);
}
