// ─── Seeds for a site crawl ─────────────────────────────────────────────────
//
// Which URLs a run starts from, and what the sitemap said about them.

import type { Crawler } from './index.js';
import type { CrawlTarget } from './core/types.js';
import type { SiteCrawlOptions } from './crawl-site-types.js';

/**
 * Decide which URLs a run starts from, and record what the sitemap told us.
 *
 * Pulled out of `crawlSite` because it answers a question the main loop does
 * not care about: the loop consumes a queue, this decides what goes in it.
 * The three sources are mutually exclusive and ordered — a resume snapshot
 * replaces everything, an explicit list beats discovery, and the base URL is
 * the fallback.
 */
export async function resolveSeeds(
  crawler: Crawler,
  target: CrawlTarget,
  options: SiteCrawlOptions,
  maxPages: number,
): Promise<{ seeds: string[]; lastmod: Record<string, string>; skippedByLastmod: string[]; fromSitemap?: boolean }> {
  const lastmod: Record<string, string> = {};
  const skippedByLastmod: string[] = [];

  // CRAWL-RESUME-1: a snapshot replaces the seeds entirely — its queue is
  // where the previous run stopped, and re-seeding from baseUrl on top would
  // re-walk ground already covered.
  if (options.resumeFrom) return { seeds: options.resumeFrom.queue, lastmod, skippedByLastmod };

  const explicit = options.seeds ?? target.seeds;
  if (explicit?.length) return { seeds: explicit, lastmod, skippedByLastmod };

  if (!options.useSitemap) return { seeds: [target.baseUrl], lastmod, skippedByLastmod };

  // Free page discovery: the site's own sitemap beats guessing paths. Goes
  // through the crawler so it uses the SAME User-Agent and DNS resolver as
  // every other request — a discovery call that resolved DNS differently from
  // the crawl would be both inconsistent and, in tests, an unstubbed network
  // call.
  // Entries the sitemap says are unmoved are skipped below, so the read reaches past them to find
  // maxPages that may have changed.
  const skippable = options.priorLastmod ? Object.keys(options.priorLastmod).length : 0;
  const entries = await crawler.discoverSeedEntries(target, maxPages + skippable);
  if (entries.length === 0) return { seeds: [target.baseUrl], lastmod, skippedByLastmod };

  for (const entry of entries) {
    if (entry.lastmod) lastmod[entry.url] = entry.lastmod;
  }

  // BETTER-LASTMOD-1: drop entries the sitemap says have not moved. The saving
  // is the FETCH itself, so this has to happen before seeding.
  const prior = options.priorLastmod;
  const fresh = prior
    ? entries.filter((entry) => {
        const unmoved = Boolean(entry.lastmod) && prior[entry.url] === entry.lastmod;
        if (unmoved) skippedByLastmod.push(entry.url);
        return !unmoved;
      })
    : entries;

  return { seeds: fresh.map((entry) => entry.url), lastmod, skippedByLastmod, fromSitemap: true };
}
