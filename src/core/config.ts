// ─── Config resolution ──────────────────────────────────────────────────────
//
// The core takes config EXPLICITLY (types.ts rule 2). This module provides
// two things on top of that:
//
//   resolveConfig()  — fills defaults, so every internal call site can read a
//                      fully-populated config without optional-chaining.
//   configFromEnv()  — OPTIONAL convenience for the common case: a consumer
//                      keeps its keys in .env / .env.local like every other
//                      service credential, and wants them picked up without
//                      hand-wiring. This is a separate, opt-in function
//                      precisely so the core stays env-free: a consumer that
//                      needs two differently-keyed crawlers in one process
//                      just builds two configs and never calls this.
//
// Env names are namespaced OLIVER_CRAWL_* first, with the bare vendor names
// (FIRECRAWL_API_KEY, ...) accepted as a fallback — those are the names the
// vendors' own docs use and what existing repos already have set, so adopting
// this package does not mean renaming working env vars.

import {
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_TEXT_CHARS,
  DEFAULT_TIMEOUT_MS,
  type CrawlConfig,
  type VendorKeys,
} from './types.js';

export type ResolvedConfig = CrawlConfig & {
  defaults: Required<NonNullable<CrawlConfig['defaults']>>;
  vendorRungOrder: string[];
};

/** Vendor rungs, cheapest/most-permissive first. Overridable via config. */
export const DEFAULT_VENDOR_RUNG_ORDER = ['firecrawl', 'apify'];

/** A deliberately generic default. Consumers SHOULD override it: an origin
 *  that wants to allow or block you cannot do either if every deployment
 *  claims the same identity, and robots.txt rules key off this string. */
export const DEFAULT_USER_AGENT = 'OliverCrawl/0.1 (+https://github.com/oliver-chase/oliver-crawl)';

export function resolveConfig(config: CrawlConfig): ResolvedConfig {
  return {
    ...config,
    userAgent: config.userAgent || DEFAULT_USER_AGENT,
    vendorRungOrder: config.vendorRungOrder ?? DEFAULT_VENDOR_RUNG_ORDER,
    defaults: {
      maxTextChars: config.defaults?.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
      timeoutMs: config.defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxPages: config.defaults?.maxPages ?? DEFAULT_MAX_PAGES,
    },
  };
}

type EnvBag = Record<string, string | undefined>;

function pick(env: EnvBag, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    // A blank or obviously-placeholder value is treated as absent, so a
    // half-filled .env disables a rung instead of failing every call with a
    // 401 the consumer then has to diagnose.
    if (value && value.trim().length > 6) return value.trim();
  }
  return undefined;
}

/**
 * Build a config from environment variables. Reads, in order of preference:
 *
 *   OLIVER_CRAWL_USER_AGENT
 *   OLIVER_CRAWL_FIRECRAWL_KEY  | FIRECRAWL_API_KEY
 *   OLIVER_CRAWL_APIFY_TOKEN    | APIFY_API_TOKEN
 *   OLIVER_CRAWL_TAVILY_KEY     | TAVILY_API_KEY
 *   OLIVER_CRAWL_SERPER_KEY     | SERPER_API_KEY
 *   OLIVER_CRAWL_VENDOR_ORDER   (comma-separated)
 *
 * Every one is optional. A missing vendor key disables that rung only — the
 * own lane never needs a key and keeps working regardless, which is the whole
 * point of the lane split (docs/LANES.md).
 */
export function configFromEnv(env: EnvBag = safeProcessEnv(), overrides: Partial<CrawlConfig> = {}): CrawlConfig {
  const vendor: VendorKeys = {
    firecrawl: pick(env, 'OLIVER_CRAWL_FIRECRAWL_KEY', 'FIRECRAWL_API_KEY'),
    apify: pick(env, 'OLIVER_CRAWL_APIFY_TOKEN', 'APIFY_API_TOKEN'),
    tavily: pick(env, 'OLIVER_CRAWL_TAVILY_KEY', 'TAVILY_API_KEY'),
    serper: pick(env, 'OLIVER_CRAWL_SERPER_KEY', 'SERPER_API_KEY'),
  };

  const order = env.OLIVER_CRAWL_VENDOR_ORDER?.split(',').map((s) => s.trim()).filter(Boolean);

  return {
    userAgent: env.OLIVER_CRAWL_USER_AGENT || DEFAULT_USER_AGENT,
    vendor,
    ...(order && order.length > 0 ? { vendorRungOrder: order } : {}),
    ...overrides,
  };
}

/** process.env is not guaranteed to exist (workerd, browsers). */
function safeProcessEnv(): EnvBag {
  return typeof process !== 'undefined' && process.env ? (process.env as EnvBag) : {};
}

/** Which vendor rungs are actually usable given the keys present. Lets a
 *  consumer show "Firecrawl: configured / not configured" without poking at
 *  raw env, and lets the vendor lane fail fast with a useful reason. */
export function availableVendorRungs(config: CrawlConfig): string[] {
  const v = config.vendor ?? {};
  const usable: string[] = [];
  if (v.firecrawl) usable.push('firecrawl');
  if (v.apify) usable.push('apify');
  return (config.vendorRungOrder ?? DEFAULT_VENDOR_RUNG_ORDER).filter((r) => usable.includes(r));
}
