// ─── What pages does this site have? ────────────────────────────────────────
//
// PARITY-MAP-1: Firecrawl's `/map` returns hundreds of a
// domain's URLs in roughly one request. Answering the same question here
// meant `crawlSite` with `followLinks`, which FETCHES every page in order to
// find the next — minutes and hundreds of requests to learn something the
// site mostly already publishes.
//
// This asks the cheap sources only:
//
//   1. /sitemap.xml (and one level of index files) — the site's own list
//   2. RSS/Atom/ICS feeds linked from the homepage
//   3. the homepage's own links
//
// One page body is fetched, total: the homepage. Everything else is a
// listing document. That is cheap enough to run BEFORE deciding what a real
// crawl should target — which turns `maxPages` into a budget you spend
// deliberately, instead of one the queue order spends for you.
//
// Deliberately NOT a crawl: it does not follow links recursively, does not
// return page content, and does not respect `maxDepth` because there is no
// depth. If you want content, feed the result to crawlSite as `seeds`.

import type { Crawler } from './index.js';
import type { CrawlTarget } from './core/types.js';
import { urlDedupKey } from './core/url-dedup-key.js';

export type SiteMapResult = {
  /** Every distinct same-site URL found, deduped by canonical identity. */
  urls: string[];
  /** Feed/calendar URLs specifically — usually the highest-value targets on
   *  a site, and worth handling before generic pages. */
  feeds: string[];
  /** Which sources contributed, for when a result looks thin. */
  sources: { sitemap: number; feeds: number; homepageLinks: number };
  /** True when a source hit its cap and more URLs exist than were returned. */
  truncated: boolean;
};

export type SiteMapOptions = {
  /** Hard ceiling on returned URLs. Default 500. */
  maxUrls?: number;
  /** Skip the homepage fetch and use only listing documents. Default false. */
  sitemapOnly?: boolean;
};

/**
 * Discover a site's URLs without crawling it.
 *
 * ```ts
 * const map = await mapSite(crawler, { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow' });
 * map.feeds;  // try these first — usually more accurate than any page
 * map.urls;   // then feed a chosen subset to crawlSite as seeds
 * ```
 */
export async function mapSite(
  crawler: Crawler,
  target: CrawlTarget,
  options: SiteMapOptions = {},
): Promise<SiteMapResult> {
  const maxUrls = Math.max(1, options.maxUrls ?? 500);

  // Canonical identity, so /events and /events/ do not both take a slot —
  // the same rule crawlSite dedups with.
  const byKey = new Map<string, string>();
  const add = (url: string) => {
    if (byKey.size >= maxUrls) return false;
    const key = urlDedupKey(url);
    if (!key || byKey.has(key)) return true;
    byKey.set(key, url);
    return true;
  };

  const sources = { sitemap: 0, feeds: 0, homepageLinks: 0 };
  let truncated = false;

  // 1. The site's own list. One request for potentially hundreds of URLs,
  //    which is the whole reason this function is cheap.
  const sitemapUrls = await crawler.discoverSeeds(target, maxUrls).catch(() => [] as string[]);
  for (const url of sitemapUrls) {
    if (!add(url)) {
      truncated = true;
      break;
    }
    sources.sitemap++;
  }

  if (options.sitemapOnly) {
    return { urls: [...byKey.values()], feeds: [], sources, truncated };
  }

  // 2 + 3. One homepage fetch yields both its links and its declared feeds.
  //        Failure here is not fatal: a sitemap-only answer is still useful,
  //        and a homepage that refuses to load should not empty the map.
  const feeds: string[] = [];
  const home = await crawler.crawl(target, target.baseUrl).catch(() => null);

  if (home && home.ok && !home.notModified) {
    const page = home.pages[0];
    if (page) {
      for (const link of page.links) {
        if (!add(link.url)) {
          truncated = true;
          break;
        }
        sources.homepageLinks++;
      }

      // Feeds are worth calling out separately: a site's ICS or RSS is
      // usually more accurate and more stable than scraping its pages, and a
      // caller should be able to prefer them without re-scanning every link.
      for (const link of page.links) {
        if (/\.(ics|rss|atom)(\?|#|$)/i.test(link.url) || /\/(feed|rss|atom)(\/|\?|#|$)/i.test(link.url)) {
          if (!feeds.includes(link.url)) {
            feeds.push(link.url);
            sources.feeds++;
          }
        }
      }
    }
  }

  return { urls: [...byKey.values()], feeds, sources, truncated };
}
