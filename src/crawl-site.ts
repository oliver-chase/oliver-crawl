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
  /** Per-URL conditional-GET validators from a previous run, keyed by URL. */
  priorValidators?: Record<string, { etag?: string | null; lastModified?: string | null }>;
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

  const done = (truncated: boolean): SiteCrawlResult => ({
    pages,
    notModified,
    failures,
    truncated,
    startedAt,
    finishedAt: new Date().toISOString(),
  });

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
  const rawSeeds = options.seeds ?? target.seeds ?? [target.baseUrl];
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

    const validators = options.priorValidators?.[url];
    const perPageOptions: CrawlOptions = {
      ...options,
      etag: validators?.etag ?? options.etag ?? null,
      lastModified: validators?.lastModified ?? options.lastModified ?? null,
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
          break;
        }
        pages.push(...result.pages);

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
    }

    if (!succeeded && lastFailure) failures.push(lastFailure);
  }

  return done(false);
}
