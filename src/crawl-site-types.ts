// ─── crawlSite types ────────────────────────────────────────────────────────
//
// The option and result shapes of crawlSite and crawlSites, kept apart from the crawl loop so that file
// reads as logic. crawl-site.ts re-exports every name here.

import type { CrawlStore } from './crawl-store.js';
import type { FailureClass } from './core/failure-class.js';
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
  /**
   * If set, ONLY follow discovered URLs matching one of these — an allowlist
   * rather than a blocklist. `[/\/events\//]` crawls a site's events
   * section and nothing else.
   *
   * Seeds are always crawled regardless: you asked for those explicitly.
   * Exclude wins over include when both match.
   *
   * (Scrapy's LinkExtractor makes the same allow/deny distinction, for the
   * same reason: on a large site, naming what you WANT is far shorter than
   * enumerating everything you don't.)
   */
  includePatterns?: RegExp[];
  /**
   * Wall-clock ceiling for the whole run, ms. When it expires the run stops
   * cleanly and reports `truncated`, keeping everything gathered so far.
   *
   * A page budget alone does not bound time: 20 pages on a site that takes
   * 30s each is a ten-minute run. Anything on a schedule needs a time bound
   * as well, or one slow origin delays every target behind it.
   */
  maxDurationMs?: number;
  /** Per-URL conditional-GET validators from a previous run, keyed by URL —
   *  exactly the shape `result.validators` (and the `onSignals` option) hands
   *  back, so the round-trip is: crawl → persist → pass here next run. */
  priorValidators?: Record<
    string,
    { etag?: string | null; lastModified?: string | null; contentRegionSha256?: string; textSha256?: string }
  >;
  /**
   * CRAWL-PARALLEL-1: pages fetched at once across the whole run.
   * Default 1, which is the sequential behavior every earlier version had.
   * Raising it only helps when the queue spans several hosts, because
   * `perHostConcurrency` still caps any one origin.
   */
  concurrency?: number;
  /** Requests in flight to one host at once. Default 1: raise it only for
   *  an origin you operate. `Crawl-delay` and the host throttle still apply. */
  perHostConcurrency?: number;
  /**
   * CRAWL-NEARDUP-1: a page whose text fingerprint is within this many bits (of 64) of a page
   * already collected in this run is reported in `duplicates` and left out of `pages`. Default 3,
   * which is about 95% similar text. -1 turns it off. Pages under 60 words are never compared.
   */
  nearDuplicateDistance?: number;
  /**
   * CRAWL-STORE-1: where this crawl keeps its queue, validators and recrawl schedule. A run
   * that finds an unfinished snapshot there continues it, and a run that follows a finished one
   * skips every discovered URL not yet due. Absent, an in-memory store is used and nothing outlives the call.
   */
  store?: CrawlStore;
  /** Key for this crawl in the store. Defaults to `targetId`, then the target's baseUrl. */
  storeKey?: string;
  /** Minimum gap between saves to the store during a run, ms. Default 1000. The final state is always saved. */
  storeIntervalMs?: number;
  /** Shortest wait before a URL is checked again, ms. Default one hour. A change resets a URL to this. */
  recrawlMinIntervalMs?: number;
  /** Longest wait, ms. Default seven days. Each unchanged check doubles the wait until it gets here. */
  recrawlMaxIntervalMs?: number;
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
  /**
   * BETTER-LASTMOD-1: `{ [url]: lastmod }` kept from a previous run, from
   * `SiteCrawlResult.lastmod`.
   *
   * With `useSitemap`, any sitemap entry whose `<lastmod>` still equals the
   * stored value is skipped WITHOUT being fetched. One sitemap request then
   * answers "which of these 500 pages changed" — conditional GET answers the
   * same question in 500 requests, one per page.
   *
   * Used only to SKIP. `<lastmod>` is origin-supplied and frequently a lie
   * (plenty of CMSs stamp every URL with today's date), so a CHANGED value
   * proves nothing and simply lets the page through to the normal 304 and
   * content-hash checks, which are trustworthy. Omit this to disable.
   */
  priorLastmod?: Record<string, string>;
  /**
   * CRAWL-RESUME-1: called after each page, with everything needed to pick
   * the run back up. Persist it (your storage, not ours) and pass the last
   * snapshot as `resumeFrom` to continue.
   *
   * Without this, a 500-page crawl killed at page 400 restarts from zero —
   * the queue and visited set live only in memory.
   */
  onProgress?: (state: CrawlProgress) => void;
  /**
   * A snapshot from a previous run's `onProgress`. Its `visited` set is
   * honoured, so pages already collected are not fetched again, and its
   * queue replaces the seeds.
   *
   * The pages themselves are NOT carried over — you already persisted those
   * when you received them. This resumes the WORK, not the results.
   */
  resumeFrom?: CrawlProgress;

  /** Persistence hook for this run's fresh validators — same data as
   *  `result.validators`, delivered as a callback for consumers that prefer
   *  push over return-value plumbing. Fire-and-forget: a throwing sink never
   *  breaks the crawl. */
  onSignals?: (targetId: string, validators: SiteCrawlResult['validators']) => void | Promise<void>;
  /** Base wait between retry attempts (multiplied by attempt number).
   *  Exists mostly so tests can zero it. */
  retryBackoffMs?: number;
};

/** One URL a run could not read. `failureClass` says whether retrying later can help. */
export type SiteCrawlFailure = { url: string; reason: string; detail: string; failureClass?: FailureClass };

/**
 * Enough state to resume a crawl. Plain JSON so a consumer can put it in a
 * row, a file or a queue message without a serialiser.
 */
export type CrawlProgress = {
  /** URLs still waiting, in breadth-first order. */
  queue: string[];
  /** Canonical dedup keys already handled — never fetch these again. */
  visited: string[];
  /** Depth per queued URL, so resuming preserves the depth limit. */
  depths: Record<string, number>;
  /** How many pages this run has collected so far, against maxPages. */
  collected: number;
};

/** How one host behaved during a run, for tuning pacing and spotting a failing source. */
export type HostStats = {
  /** Fetch attempts made against the host, retries included. */
  attempts: number;
  /** Pages returned, including 304s. */
  pages: number;
  /** Failed attempts by `failureClass`. */
  failures: { transient: number; structural: number };
  /** Attempts the origin answered with 403 or 429, as a share of attempts (0 to 1). */
  blockRate: number;
  /** Median wall time of an attempt, ms. */
  medianLatencyMs: number;
};

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
  /** `<lastmod>` per URL from this run's sitemap, for `priorLastmod` next
   *  time. Empty when no sitemap was read or it published no lastmod. */
  lastmod: Record<string, string>;
  /** URLs skipped because their sitemap `<lastmod>` was unchanged — never
   *  fetched at all. Not failures, and not `notModified` (no request was
   *  made to be answered). */
  skippedByLastmod: string[];
  /** URLs left unfetched because the recrawl schedule says they are not due yet. */
  notDue: string[];
  /** The first error the store threw while loading or saving. The run itself completed. Absent when the store worked. */
  storeError?: string;
  /** Pages left out of `pages` because an earlier page in this run carries the same content. */
  duplicates: { url: string; of: string; distance: number }[];
  /** CRAWL-HOST-STATS-1: per-host behavior of this run, keyed by hostname. */
  hosts: Record<string, HostStats>;
  startedAt: string;
  finishedAt: string;
};

export type MultiSiteOptions = SiteCrawlOptions & {
  /** Sites crawled at once. Default 4. Each site still honours its own
   *  `concurrency` and `perHostConcurrency`, and the per-host slot is
   *  process-wide, so two targets on one origin never exceed its limit. */
  siteConcurrency?: number;
};

export type MultiSiteResult = { target: CrawlTarget; result: SiteCrawlResult };
