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
import type { CrawlConfig, CrawlOptions, CrawlResult, CrawlTarget, LaneName } from './core/types.js';

export type Crawler = {
  /** Crawl one URL, trying the requested lanes in order. */
  crawl: (target: CrawlTarget, url: string, options?: CrawlOptions) => Promise<CrawlResult>;
  /** Which vendor rungs are usable with the current keys. Empty is normal
   *  and fine — it just means the own lane is the only one available. */
  vendorRungs: () => string[];
};

export function createCrawler(config: CrawlConfig): Crawler {
  const resolved = resolveConfig(config);

  return {
    vendorRungs: () => availableVendorRungs(resolved),

    async crawl(target, url, options = {}) {
      // Default: own lane only. A caller must opt IN to spending money.
      const lanes: LaneName[] = options.lanes?.length ? options.lanes : ['own'];
      let last: CrawlResult = {
        ok: false,
        reason: 'no_lane_available',
        detail: 'No lanes were configured for this crawl.',
      };

      for (const lane of lanes) {
        const result =
          lane === 'own'
            ? await crawlWithOwnLane(target, url, resolved, options)
            : await crawlWithVendorLane(target, url, resolved, options);

        if (result.ok) return result;

        // 'blocked' and 'quarantined' are POLICY decisions, not transport
        // failures — escalating to a vendor would be paying to route around
        // our own guard, so they end the crawl immediately.
        if (result.reason === 'blocked' || result.reason === 'quarantined') return result;

        last = result;
      }

      return last;
    },
  };
}

export { configFromEnv, resolveConfig, availableVendorRungs, DEFAULT_USER_AGENT };
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
export { isSafeHttpUrl } from './core/url-safety.js';
export { evaluateRobotsForUrl, parseRobots, userAgentToken } from './fetch/robots-check.js';
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
