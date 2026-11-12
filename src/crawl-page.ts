// ─── One URL of a site crawl ────────────────────────────────────────────────
//
// Crawl a single URL with retries, fold its pages into the run's collections, and queue what it links to.
// crawlSite owns the collections and the loop; this owns what happens to one URL.

import { urlDedupKey } from './core/url-dedup-key.js';
import { sleep } from './core/host-throttle.js';
import { findNextPageUrl } from './extract/pagination-discovery.js';
import { hostOf } from './crawl-host-stats.js';
import type { createHostStats } from './crawl-host-stats.js';
import type { createNearDuplicateIndex } from './extract/near-duplicate.js';
import type { Crawler } from './index.js';
import type { CrawlOptions, CrawlPage, CrawlTarget } from './core/types.js';
import type { SiteCrawlFailure, SiteCrawlOptions, SiteCrawlResult } from './crawl-site-types.js';

/** What the page step reads and writes: the run's collections, owned by crawlSite. */
export type PageStepContext = {
  crawler: Crawler;
  target: CrawlTarget;
  options: SiteCrawlOptions;
  maxRetries: number;
  pages: CrawlPage[];
  notModified: string[];
  failures: SiteCrawlFailure[];
  validators: SiteCrawlResult['validators'];
  unchanged: string[];
  duplicates: SiteCrawlResult['duplicates'];
  visited: Set<string>;
  nearDuplicates: ReturnType<typeof createNearDuplicateIndex>;
  stats: ReturnType<typeof createHostStats>;
  touch: (key: string, unchangedNow: boolean, requested?: string) => void;
  enqueue: (rawUrl: string, depth: number) => void;
};

export function createPageProcessor(ctx: PageStepContext) {
  const { crawler, target, options, maxRetries, pages, notModified, failures, validators, unchanged, duplicates, visited, nearDuplicates, stats, touch, enqueue } = ctx;
  return async (url: string, urlKey: string, depth: number): Promise<void> => {
    const prior = options.priorValidators?.[url];
    const perPageOptions: CrawlOptions = {
      ...options,
      etag: prior?.etag ?? options.etag ?? null,
      lastModified: prior?.lastModified ?? options.lastModified ?? null,
      // Pagination discovery reads markup, so the page must carry its HTML.
      // Requested here so that
      // followPagination does not silently do nothing.
      includeHtml: options.includeHtml || options.followPagination === true,
      // This loop does its own retrying; letting crawl() retry too would
      // multiply attempts (3 x 3 = 9 requests for one page).
      retries: 0,
    };

    let lastFailure: SiteCrawlFailure | null = null;
    let succeeded = false;

    for (let attempt = 0; attempt <= maxRetries && !succeeded; attempt++) {
      const attemptStarted = Date.now();
      const result = await crawler.crawl(target, url, perPageOptions);
      stats.record(hostOf(url), attemptStarted, result);

      if (result.ok) {
        succeeded = true;
        if (result.notModified) {
          notModified.push(url);
          touch(url, true);
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
        // CRAWL-DEDUP-1: URLs that redirect to one page, such as /home, /index
        // and /, are one page. The resolved URL is marked visited too, and a
        // page already collected under it is dropped.
        const fresh = result.pages.filter((p) => {
          const key = urlDedupKey(p.url);
          if (visited.has(key) && key !== urlKey) return false;
          visited.add(key);
          return true;
        });
        // CRAWL-NEARDUP-1: the same content under another URL is reported, not returned again. Its
        // links and validators are still used below, since the page itself was read.
        for (const p of fresh) {
          const twin = nearDuplicates.check(p.url, p.contentSimhash);
          if (twin) duplicates.push({ url: p.url, of: twin.of, distance: twin.distance });
          else pages.push(options.includeHtml ? p : { ...p, html: undefined });
        }
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
          touch(p.url, same, url);
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

      lastFailure = { url, reason: result.reason, detail: result.detail, ...(result.failureClass ? { failureClass: result.failureClass } : {}) };
      // Retrying these produces the identical answer; spend the budget elsewhere.
      if (result.failureClass === 'structural') break;
      if (attempt < maxRetries) {
        // CRAWL-BACKOFF-1: when the origin SAID how long to wait (429/503 +
        // Retry-After), wait that long. Our own schedule is a guess; theirs
        // is an instruction, and ignoring it is what gets a crawler banned.
        const ourBackoff = (options.retryBackoffMs ?? 500) * (attempt + 1);
        await sleep(Math.max(result.retryAfterMs ?? 0, ourBackoff));
      }
    }

    if (!succeeded && lastFailure) failures.push(lastFailure);
  };
}
