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
  /** Follow "next page" links discovered on crawled pages, up to maxPages.
   *  Narrow by design: only pagination, so a listing's page 2/3 are read. */
  followPagination?: boolean;
  /**
   * Follow ALL same-site links, breadth-first, to discover a whole site from
   * one starting URL. This is what answers "I gave it example.com, I want
   * /calendar and /menu and /locations too" — pagination alone will not do
   * that, and a sitemap only helps if the site publishes one.
   *
   * Bounded by maxPages and maxDepth. Breadth-first on purpose: the pages
   * linked from the homepage are the ones a site considers important, so a
   * truncated crawl keeps the useful pages rather than descending one deep
   * branch.
   */
  followLinks?: boolean;
  /** How many link-hops from a seed to travel when followLinks is on.
   *  Default 2 — the homepage, its sections, and their pages. */
  maxDepth?: number;
  /** Skip discovered URLs matching any of these. Applied to the full URL.
   *  Useful for the parts of a site that are never worth crawling (login,
   *  cart, calendar permalinks that expand forever). */
  excludePatterns?: RegExp[];
  /** Per-URL conditional-GET validators from a previous run, keyed by URL —
   *  exactly the shape `result.validators` (and `config.onSignals`) hands
   *  back, so the round-trip is: crawl → persist → pass here next run. */
  priorValidators?: Record<
    string,
    { etag?: string | null; lastModified?: string | null; contentRegionSha256?: string; textSha256?: string }
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
    {
      etag: string | null;
      lastModified: string | null;
      bodySha256: string;
      /** Structural, nav-insensitive. EMPTY on text-only rungs (Jina/vendor). */
      contentRegionSha256: string;
      /** Always set — the universally comparable signal. */
      textSha256: string;
    }
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

  // Dedup across seeds AND everything discovered — a site whose page 2 links
  // back to page 1, or whose nav links every page to every other page, must
  // not loop.
  const visited = new Set<string>();
  const maxDepth = Math.max(0, options.maxDepth ?? 2);
  // Depth rides alongside the URL so breadth-first ordering is preserved and
  // a deep branch cannot consume the whole page budget.
  const depthOf = new Map<string, number>();
  for (const seed of queue) depthOf.set(seed, 0);

  const shouldSkip = (candidate: string) =>
    (options.excludePatterns ?? []).some((pattern) => pattern.test(candidate));

  /** Queue a discovered URL if it is same-site, unseen, and within depth. */
  const enqueue = (rawUrl: string, depth: number) => {
    if (depth > maxDepth) return;
    if (shouldSkip(rawUrl)) return;
    try {
      const safe = assertRequestUrlAllowed(target, rawUrl).toString();
      if (visited.has(safe) || depthOf.has(safe)) return;
      depthOf.set(safe, depth);
      queue.push(safe);
    } catch {
      // Off-site or unsafe — not an error, just not ours to follow.
    }
  };

  while (queue.length > 0) {
    if (pages.length + notModified.length >= maxPages) return done(true);

    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    const depth = depthOf.get(url) ?? 0;

    const prior = options.priorValidators?.[url];
    const perPageOptions: CrawlOptions = {
      ...options,
      etag: prior?.etag ?? options.etag ?? null,
      lastModified: prior?.lastModified ?? options.lastModified ?? null,
      // Pagination discovery reads markup, so the page must carry its HTML.
      // Requested here rather than left to the caller: otherwise
      // followPagination would silently do nothing.
      includeHtml: options.includeHtml || options.followPagination === true || options.followLinks === true,
      // This loop does its own retrying; letting crawl() retry too would
      // multiply attempts (3 x 3 = 9 requests for one page).
      retries: 0,
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
              textSha256: prior.textSha256 ?? '',
            };
          }
          break;
        }
        // CRAWL-DEDUP-1 (found in a live run): dedup keyed only on the
        // REQUESTED url, so two different URLs that redirect to the same
        // page were both crawled and both stored — a real site's
        // /home, /index and / commonly converge. Mark the RESOLVED url
        // visited too, and drop a page already collected under it.
        const fresh = result.pages.filter((p) => {
          if (visited.has(p.url) && p.url !== url) return false;
          visited.add(p.url);
          return true;
        });
        pages.push(...fresh);
        for (const p of fresh) {
          // CRAWL-UNCHANGED-1: these hashes were computed on every page and
          // then thrown away. Comparing against last run is what makes
          // re-crawls cheap for origins that send NO ETag (most small sites):
          // the page had to be fetched, but extraction/LLM need not re-run.
          //
          // CRAWL-HASH-1: compare LIKE WITH LIKE. contentRegionSha256 is
          // structural (HTML-only) and is the better signal, but it is empty
          // on text-only rungs — comparing it across a rung change would
          // report a false content change. Prefer it only when both sides
          // have it; otherwise fall back to the always-present text hash.
          const prev = options.priorValidators?.[p.url];
          const bothStructural = Boolean(prev?.contentRegionSha256 && p.contentRegionSha256);
          const same = bothStructural
            ? prev!.contentRegionSha256 === p.contentRegionSha256
            : Boolean(prev?.textSha256 && prev.textSha256 === p.textSha256);
          if (same) unchanged.push(p.url);
          validators[p.url] = {
            etag: p.httpEtag,
            lastModified: p.httpLastModified,
            bodySha256: p.bodySha256,
            contentRegionSha256: p.contentRegionSha256,
            textSha256: p.textSha256,
          };
        }

        // Discovery from the page just read — appends only, so breadth-first
        // ordering of what was already scheduled is preserved.
        const first = fresh[0];

        // Pagination stays at the SAME depth: page 2 of a listing is the same
        // distance from the seed as page 1, not one hop further.
        if (options.followPagination && first?.html) {
          const next = findNextPageUrl(first.html, url);
          if (next) enqueue(next, depth);
        }

        // Whole-site discovery: every same-site link, one hop deeper.
        if (options.followLinks && first) {
          for (const link of first.links) enqueue(link.url, depth + 1);
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
