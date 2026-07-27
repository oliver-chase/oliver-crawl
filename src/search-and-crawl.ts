// ─── Search, then read what you found ───────────────────────────────────────
//
// The bridge between the two surfaces. Searching gives you URLs; you almost
// never want URLs, you want what is ON them. Every consumer was writing this
// join by hand, and getting the same two things wrong:
//
//   1. Crawling search results WITHOUT re-applying host policy. A search
//      provider is an untrusted source of URLs — it will happily hand back a
//      link to anywhere, and feeding those straight into a fetcher is how a
//      "search feature" becomes an SSRF. Here every result is crawled through
//      the same guards as any other target.
//   2. Paying for the search, then paying a vendor to scrape every result.
//      This crawls with the FREE lane by default; the paid lane is opt-in
//      exactly as everywhere else.
//
// Each result is crawled as its own single-page target, because a search
// result set spans many unrelated hosts — this is deliberately NOT a site
// crawl, and same-site rules apply per result, not across them.

import type { Crawler } from './index.js';
import type { CrawlOptions, CrawlPage } from './core/types.js';
import type { SearchResult } from './search/index.js';

export type SearchAndCrawlOptions = CrawlOptions & {
  /** How many search results to take. Default 3. */
  maxResults?: number;
  /** Restrict the search to one site. */
  site?: string;
  /** Skip crawling and return search results only — useful when the snippet
   *  is enough and you want to decide what is worth fetching. */
  searchOnly?: boolean;
  /**
   * CRAWL-CONCURRENCY-1: how many results to read at once. Default 1.
   *
   * Safe to raise HERE specifically, because a search result set spans many
   * unrelated hosts and `core/host-throttle.ts` already serialises requests to
   * any single host process-wide. Two results that happen to share a host
   * still queue behind each other; two on different hosts genuinely run in
   * parallel.
   *
   * Default stays 1 so nothing changes for existing callers.
   */
  concurrency?: number;
};

export type SearchAndCrawlResult =
  | {
      ok: true;
      /** The raw search hits, in provider order. */
      results: SearchResult[];
      /** Pages successfully read. May be shorter than `results` — some hosts
       *  refuse crawling, and that is normal, not a failure of the whole. */
      pages: CrawlPage[];
      /** Per-URL reasons for the results that could not be read. */
      skipped: Array<{ url: string; reason: string; detail: string }>;
      provider: string;
    }
  | { ok: false; reason: string; detail: string };

/**
 * Search the web and read the pages found, in one call.
 *
 * ```ts
 * const found = await searchAndCrawl(crawler, 'summer concert series rochester');
 * for (const page of found.ok ? found.pages : []) useText(page.text);
 * ```
 */
export async function searchAndCrawl(
  crawler: Crawler,
  query: string,
  options: SearchAndCrawlOptions = {},
): Promise<SearchAndCrawlResult> {
  const found = await crawler.search(query, {
    maxResults: options.maxResults ?? 3,
    ...(options.site ? { site: options.site } : {}),
  });

  if (!found.ok) return { ok: false, reason: found.reason, detail: found.detail };
  if (options.searchOnly) {
    return { ok: true, results: found.results, pages: [], skipped: [], provider: found.provider };
  }

  const pages: CrawlPage[] = [];
  const skipped: Array<{ url: string; reason: string; detail: string }> = [];

  const readOne = async (result: SearchResult) => {
    let origin: string;
    try {
      origin = new URL(result.url).origin;
    } catch {
      skipped.push({ url: result.url, reason: 'blocked', detail: 'Search returned an unparseable URL.' });
      return;
    }

    // Each result is its own target scoped to its own origin. robotsPolicy is
    // left unset so it fails closed unless the crawler is configured with
    // autoRobots — a search result is not permission to crawl a stranger's
    // site, and the caller should have to opt into resolving that.
    const crawled = await crawler.crawl({ baseUrl: origin, name: origin }, result.url, options);

    if (crawled.ok && !crawled.notModified) pages.push(...crawled.pages);
    else if (!crawled.ok) skipped.push({ url: result.url, reason: crawled.reason, detail: crawled.detail });
  };

  const lanes = Math.max(1, Math.floor(options.concurrency ?? 1));
  if (lanes === 1) {
    for (const result of found.results) await readOne(result);
  } else {
    // Fixed pool of workers pulling from a shared cursor — bounded memory and
    // bounded in-flight requests regardless of how many results came back.
    const queue = [...found.results];
    await Promise.all(
      Array.from({ length: Math.min(lanes, queue.length) }, async () => {
        for (;;) {
          const next = queue.shift();
          if (!next) return;
          await readOne(next);
        }
      }),
    );
  }

  return { ok: true, results: found.results, pages, skipped, provider: found.provider };
}
