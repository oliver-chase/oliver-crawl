// ─── oliver-crawl ───────────────────────────────────────────────────────────
//
// Governed web crawling with two independent lanes:
//
//   own    — our crawler. No keys, no cost. SSRF/DNS-rebinding guards,
//            prompt-injection sanitising, conditional GET, JSON-LD, content
//            -region hashing. The default.
//   vendor — third-party scraping APIs (Firecrawl, Apify). Off unless asked
//            for, and only usable if a key is configured.
//
// Pick one, or both. `lanes: ['own']` is the default and never spends money.
// `lanes: ['own', 'vendor']` is the common production shape: try free first,
// escalate only for pages the free lane genuinely cannot read.
//
//   import { createCrawler, configFromEnv } from '@oliver/crawl-core';
//
//   const crawler = createCrawler(configFromEnv());
//   const result = await crawler.crawl(
//     { baseUrl: 'https://example.com', robotsPolicy: 'allow' },
//     'https://example.com/events',
//     { lanes: ['own', 'vendor'] },
//   );
//   if (result.ok && !result.notModified) console.log(result.pages[0]?.text);
//
// Ordinary failure is a value, never an exception: check `result.ok`.

import { resolveConfig, availableVendorRungs, configFromEnv, DEFAULT_USER_AGENT } from './core/config.js';
import { crawlWithOwnLane } from './lanes/own/index.js';
import { crawlWithVendorLane } from './lanes/vendor/index.js';
import type { SitemapEntry } from './fetch/sitemap-discovery.js';
import { approveCrawlPolicy } from './lanes/own/index.js';
import { classifyFailure } from './core/failure-class.js';
import { rememberWinningRung } from './core/rung-memory.js';
import { search, availableSearchProviders } from './search/index.js';
import { readPageCache, writePageCache } from './core/page-cache.js';
import { discoverSitemapUrls } from './fetch/sitemap-discovery.js';
import type { SearchOutcome, SearchOptions } from './search/index.js';
import type { CrawlConfig, CrawlOptions, CrawlResult, CrawlTarget, LaneName } from './core/types.js';

export type Crawler = {
  /** Crawl one URL, trying the requested lanes in order. */
  crawl: (target: CrawlTarget, url: string, options?: CrawlOptions) => Promise<CrawlResult>;
  /** Search the web. A different surface from crawling — query in, URLs out —
   *  and always paid, so it reports WHY it came back empty. */
  search: (query: string, options?: SearchOptions) => Promise<SearchOutcome>;
  /**
   * Sitemap entries WITH their `<lastmod>` (BETTER-LASTMOD-1). Same request
   * as discoverSeeds — goes through the crawler so it uses the configured
   * User-Agent and DNS resolver, not a second set.
   */
  discoverSeedEntries: (target: CrawlTarget, maxUrls?: number) => Promise<SitemapEntry[]>;
  /** Which vendor rungs are usable with the current keys. Empty is normal
   *  and fine — it just means the own lane is the only one available. */
  vendorRungs: () => string[];
  /** Which search providers are usable with the current keys. */
  searchProviders: () => string[];
  /** Discover a target's pages from its own /sitemap.xml, using THIS
   *  crawler's User-Agent and DNS resolver. Free. Empty list when the site
   *  has no sitemap — a normal condition, not an error. */
  discoverSeeds: (target: CrawlTarget, maxUrls?: number) => Promise<string[]>;
};

export function createCrawler(config: CrawlConfig): Crawler {
  const resolved = resolveConfig(config);

  return {
    vendorRungs: () => availableVendorRungs(resolved),
    searchProviders: () => availableSearchProviders(resolved),
    discoverSeeds: async (target, maxUrls) => {
      const found = await discoverSitemapUrls(target, {
        userAgent: resolved.userAgent,
        dnsLookup: resolved.dnsLookup,
        ...(maxUrls === undefined ? {} : { maxUrls }),
      });
      return found.urls;
    },
    discoverSeedEntries: async (target, maxUrls) => {
      const found = await discoverSitemapUrls(target, {
        userAgent: resolved.userAgent,
        dnsLookup: resolved.dnsLookup,
        ...(maxUrls === undefined ? {} : { maxUrls }),
      });
      return found.entries;
    },
    search: (query, options) => search(query, resolved, options),

    async crawl(target, url, options = {}) {
      // CRAWL-DEGRADE-1: every failure leaving crawl() is classified here,
      // in ONE place. Stamping it at each individual return site would drift
      // the moment a new failure path is added.
      const withClass = (result: CrawlResult): CrawlResult =>
        result.ok || result.failureClass
          ? result
          : { ...result, failureClass: classifyFailure(result.reason, result.detail) };

      // Default: own lane only. A caller must opt IN to spending money.
      const lanes: LaneName[] = options.lanes?.length ? options.lanes : ['own'];
      const ttl = resolved.cacheTtlMs ?? 0;

      // VENDOR-POLICY-1: policy holds for EVERY lane. Without this, a
      // vendor-only crawl ran unvetted — no same-site rule, no robots check —
      // and a paid vendor fetched what our own guard would have refused.
      // Cheap to repeat for the own lane (robots is cached per host, the
      // asserts are pure); the own lane still adds its DNS/SSRF check, which
      // only matters when OUR socket connects.
      //
      // CACHE-POLICY-1 (2026-07-27, found in review): this runs BEFORE the
      // cache read, and the order is load-bearing. The page cache is keyed on
      // (url, lanes) and NOT on the target, so serving a hit first let a
      // second target read a page it was never allowed to fetch — an
      // off-domain URL, an inactive source, a robots-disallowed path. Policy
      // is a property of the ASKING target; the cache only knows the URL.
      try {
        await approveCrawlPolicy(target, url, resolved);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return withClass({ ok: false, reason: 'blocked', detail });
      }

      // A repeat of the same URL in the cache window costs nothing. Only
      // successful non-304 results are ever stored — see core/page-cache.ts.
      const cached = readPageCache(url, lanes, ttl);
      if (cached) return cached;

      // Retry lives HERE for single-page callers, and crawlSite passes 0
      // because it runs its own loop — two retry layers would multiply.
      const attempts = Math.max(0, options.retries ?? 0) + 1;
      let last: CrawlResult = {
        ok: false,
        reason: 'no_lane_available',
        detail: 'No lanes were configured for this crawl.',
      };

      for (let attempt = 0; attempt < attempts; attempt++) {
        for (const lane of lanes) {
          const result =
            lane === 'own'
              ? await crawlWithOwnLane(target, url, resolved, options)
              : await crawlWithVendorLane(url, resolved, options);

          if (result.ok) {
            // BETTER-RUNGMEMORY-1: recorded HERE, in one place, from the rung
            // the page itself reports — rather than at each rung's success
            // site, which would drift the moment a rung is added. Success
            // only: remembering failures is the trap the robots cache had.
            if (resolved.rungMemory !== false && !result.notModified) {
              const page = result.pages[0];
              if (page) {
                try {
                  rememberWinningRung(resolved.rungMemoryStore, new URL(url).hostname, page.rung);
                } catch {
                  // Unparseable URL — nothing to key a memory on.
                }
              }
            }
            writePageCache(url, lanes, ttl, result);
            return result;
          }

          // 'blocked' and 'quarantined' are POLICY decisions, not transport
          // failures — escalating to a vendor would be paying to route around
          // our own guard, and retrying cannot change the answer.
          if (result.reason === 'blocked' || result.reason === 'quarantined') return withClass(result);

          last = result;
        }
      }

      return withClass(last);
    },
  };
}

export { configFromEnv, resolveConfig, availableVendorRungs, DEFAULT_USER_AGENT };
// Multi-page orchestration: drives crawl() across a target's seeds, with a
// page budget, retry policy, dedup and optional pagination following.
export { crawlSite } from './crawl-site.js';
export { mapSite } from './map-site.js';
export type { SiteMapResult, SiteMapOptions } from './map-site.js';
// Search then read what was found — with host policy re-applied per result,
// because a search provider is an untrusted source of URLs.
export { searchAndCrawl } from './search-and-crawl.js';
export type { SearchAndCrawlOptions, SearchAndCrawlResult } from './search-and-crawl.js';
export { search as searchWeb, availableSearchProviders, DEFAULT_SEARCH_PROVIDER_ORDER } from './search/index.js';
export type { SearchResult, SearchOutcome, SearchOptions } from './search/index.js';
export type { SiteCrawlOptions, SiteCrawlResult, SiteCrawlFailure, CrawlProgress } from './crawl-site.js';
export { DEFAULT_VENDOR_RUNG_ORDER } from './core/config.js';
export type { ResolvedConfig } from './core/config.js';

export type {
  CrawlConfig,
  CrawlFailureReason,
  CrawlOptions,
  CrawlPage,
  CrawlResult,
  CrawlTarget,
  DnsAddress,
  DnsLookupFn,
  LaneName,
  PageLink,
  UsageEvent,
  VendorKeys,
  BudgetCheck,
} from './core/types.js';

export { DEFAULT_MAX_TEXT_CHARS, DEFAULT_MAX_PAGES, DEFAULT_TIMEOUT_MS } from './core/types.js';

// Guards and extractors are exported directly too: a consumer migrating
// incrementally often wants just the sanitiser or the JSON-LD reader before
// it adopts the full crawler.
export { sanitizeCrawledText, detectPromptInjectionSignals } from './guard/prompt-injection-guard.js';
export { extractJsonLdEvent, extractAllJsonLdEvents } from './extract/jsonld-event.js';
export { extractJsonLdAddress, formatJsonLdAddress } from './extract/jsonld-address.js';
export { computeContentRegionHash } from './extract/content-region-hash.js';
export { summarizeStructuredData } from './extract/structured-summary.js';
export { findContentImages } from './extract/content-images.js';
export type { ContentImage } from './extract/content-images.js';
export { diffContent } from './extract/content-diff.js';
export type { ContentDiff, ContentChange } from './extract/content-diff.js';
export { pickDetailLinks } from './extract/detail-link-picker.js';
export type { DetailLinkMatch, DetailKeywords } from './extract/detail-link-picker.js';
export type { StructuredSummary } from './extract/structured-summary.js';
export { isSafeHttpUrl } from './core/url-safety.js';
export { classifyContentType, refineKindByUrl } from './core/content-kind.js';
export { classifyFailure } from './core/failure-class.js';
export type { FailureClass } from './core/failure-class.js';
export { looksLikeEmptyState } from './core/soft-404.js';
export { EXTRACTOR_VERSION } from './core/extractor-version.js';
export { createRungMemory, rememberWinningRung, recallWinningRung, forgetWinningRung, RUNG_MEMORY_TTL_MS } from './core/rung-memory.js';
export type { RungMemory } from './core/rung-memory.js';
export { urlDedupKey, sameUrlResource } from './core/url-dedup-key.js';
export { evaluateRobotsForUrl, parseRobots, userAgentToken, MAX_HONORED_CRAWL_DELAY_MS } from './fetch/robots-check.js';
export { publishedCrawlDelayMs } from './lanes/own/index.js';
export type { RobotsPolicy, RobotsCheckResult } from './fetch/robots-check.js';
export {
  discoverIcsFeed,
  parseFeedLinksFromHtml,
  googleCalendarIcsCandidates,
  candidateIcsUrls,
  safeFetch,
} from './fetch/feed-discovery.js';
export type { FeedDiscoveryResult } from './fetch/feed-discovery.js';
export { findNextPageUrl, discoverPaginatedUrls } from './extract/pagination-discovery.js';
export { discoverSitemapUrls } from './fetch/sitemap-discovery.js';
export type { SitemapDiscoveryResult, SitemapEntry } from './fetch/sitemap-discovery.js';
export { renderViaLocalChromium } from './fetch/local-render.js';
export { createDohLookup, DEFAULT_DOH_ENDPOINT } from './fetch/host-policy.js';
export { renderViaService, renderServiceFrom } from './fetch/browser-render.js';
export type { RenderResult } from './fetch/browser-render.js';
export { probeCheapChangeSignal, cheapSignalsMatch } from './fetch/cheap-change-probe.js';
export type { CheapChangeSignal, CheapChangeSignalStore } from './fetch/cheap-change-probe.js';
// Recipe REPLAY only — learning a recipe is domain-specific and stays in the
// consuming app (see src/extract/extraction-recipe.ts's header).
export { applyRecipe, parseStoredRecipe, MAX_RECIPE_FAILURES } from './extract/extraction-recipe.js';
export type { ExtractionRecipe, RecipeDraft, RecipeFieldRule } from './extract/extraction-recipe.js';
export {
  assertHostResolvesToPublicAddress,
  assertRequestUrlAllowed,
  assertRedirectUrlAllowed,
  assertRedirectUrlAllowedForHost,
  assertTargetEligible,
  assertPublicHost,
} from './fetch/host-policy.js';
