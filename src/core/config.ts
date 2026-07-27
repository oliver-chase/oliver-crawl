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

import { createDohLookup } from '../fetch/host-policy.js';
import { createRungMemory, type RungMemory } from './rung-memory.js';
import {
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_TEXT_CHARS,
  DEFAULT_TIMEOUT_MS,
  type CrawlConfig,
  type VendorKeys,
} from './types.js';

export type ResolvedConfig = CrawlConfig & {
  /** Per-crawler rung memory (BETTER-RUNGMEMORY-1). Never shared. */
  rungMemoryStore: RungMemory;
  defaults: Required<NonNullable<CrawlConfig['defaults']>>;
  vendorRungOrder: string[];
  limits: Required<NonNullable<CrawlConfig['limits']>>;
};

/** Safety/scale defaults. Exposed as config because the right value depends
 *  on the pages a consumer actually crawls — a limit you cannot raise is a
 *  limit that silently loses data. */
export const DEFAULT_LIMITS = {
  maxBodyBytes: 2_000_000,
  maxLinksPerPage: 200,
  maxOutboundHosts: 25,
};

/** Vendor rungs, cheapest/most-permissive first. Overridable via config. */
export const DEFAULT_VENDOR_RUNG_ORDER = ['firecrawl', 'apify'];

/** A deliberately generic default. Consumers SHOULD override it: an origin
 *  that wants to allow or block you cannot do either if every deployment
 *  claims the same identity, and robots.txt rules key off this string. */
export const DEFAULT_USER_AGENT = 'OliverCrawl/0.1 (+https://github.com/oliver-chase/oliver-crawl)';

/**
 * CRAWL-UA-1: a User-Agent with no way to reach you is a significant cause of
 * being blocked — a site operator seeing unexplained traffic has no contact
 * to try, so they block instead of asking.
 *
 * Warned, never thrown: a caller may have a legitimate reason, and breaking
 * their crawl over a style rule would be worse than the problem. Once per
 * process, so a 500-page run does not print 500 warnings.
 */
const WARNED_USER_AGENTS = new Set<string>();

export function __clearUserAgentWarningsForTests(): void {
  WARNED_USER_AGENTS.clear();
}

function warnIfNoContact(userAgent: string): void {
  if (/https?:\/\/|\+[\w.-]+@|\(\+/.test(userAgent)) return;
  if (WARNED_USER_AGENTS.has(userAgent)) return;
  WARNED_USER_AGENTS.add(userAgent);
  console.warn(
    `[oliver-crawl] userAgent "${userAgent}" has no contact URL. Site operators ` +
      'block unexplained traffic they cannot ask about. Prefer e.g. ' +
      '"MyBot/1.0 (+https://mysite.com/bot)".',
  );
}

export function resolveConfig(config: CrawlConfig): ResolvedConfig {
  const userAgent = config.userAgent || DEFAULT_USER_AGENT;
  warnIfNoContact(userAgent);
  return {
    ...config,
    userAgent,
    // Per-crawler, never shared — see core/rung-memory.ts.
    rungMemoryStore: createRungMemory(),
    vendorRungOrder: config.vendorRungOrder ?? DEFAULT_VENDOR_RUNG_ORDER,
    defaults: {
      maxTextChars: config.defaults?.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
      timeoutMs: config.defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxPages: config.defaults?.maxPages ?? DEFAULT_MAX_PAGES,
    },
    limits: {
      maxBodyBytes: config.limits?.maxBodyBytes ?? DEFAULT_LIMITS.maxBodyBytes,
      maxLinksPerPage: config.limits?.maxLinksPerPage ?? DEFAULT_LIMITS.maxLinksPerPage,
      maxOutboundHosts: config.limits?.maxOutboundHosts ?? DEFAULT_LIMITS.maxOutboundHosts,
    },
    // A custom DoH endpoint only matters when no resolver was injected.
    dnsLookup: config.dnsLookup ?? (config.dohEndpoint ? createDohLookup(config.dohEndpoint) : undefined),
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
 *   OLIVER_CRAWL_SEARCH_ORDER   (comma-separated)
 *   OLIVER_CRAWL_LOCAL_RENDER=1 (free local-Chromium render rung)
 *   OLIVER_CRAWL_AUTO_ROBOTS=1  (resolve unknown robots posture for real)
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
  const searchOrder = env.OLIVER_CRAWL_SEARCH_ORDER?.split(',').map((s) => s.trim()).filter(Boolean);

  return {
    userAgent: env.OLIVER_CRAWL_USER_AGENT || DEFAULT_USER_AGENT,
    vendor,
    ...(env.OLIVER_CRAWL_LOCAL_RENDER === '1' ? { localRender: true } : {}),
    ...(env.OLIVER_CRAWL_AUTO_ROBOTS === '1' ? { autoRobots: true } : {}),
    ...(order && order.length > 0 ? { vendorRungOrder: order } : {}),
    ...(searchOrder && searchOrder.length > 0 ? { searchProviderOrder: searchOrder } : {}),
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
