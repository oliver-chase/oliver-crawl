// ─── Robots posture for the own lane ────────────────────────────────────────
//
// Resolving a target's robots posture, caching it per host, and the policy approval every crawl runs first.

import { assertRequestUrlAllowed, assertTargetEligible } from '../../fetch/host-policy.js';
import { evaluateRobotsForUrl, parseRobots, userAgentToken, type RobotsPolicy } from '../../fetch/robots-check.js';
import type { ResolvedConfig } from '../../core/config.js';
import type { CrawlTarget } from '../../core/types.js';

// CRAWL-ROBOTS-1: robots.txt was ported but nothing ever CALLED it, so a
// "governed crawler" was only as governed as the consumer's bookkeeping. With
// config.autoRobots on, an 'unknown' posture is resolved for real and cached per
// HOST — one robots.txt request per host, not per page.
//
// ROBOTS-TTL-1: each answer expires, so a long-lived process sees a site add a
// Disallow, and a transient failure, cached as 'unknown' and failing closed,
// does not stop a host for good.
//
// The two TTLs are deliberately asymmetric: a successful answer is cheap to
// trust for hours, a failure must be retried soon, because the cost of holding
// it is a host that silently stops working.
export const ROBOTS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — resolved posture
export const ROBOTS_FAILURE_TTL_MS = 5 * 60 * 1000; //     5m — unresolved, retry soon

/** One host's robots.txt: the posture for the URL first resolved, the rules text when it was read, and its Crawl-delay. */
type RobotsCacheEntry = { pending: Promise<RobotsPolicy>; expiresAt: number; rules: string | null; crawlDelayMs: number | null };

/** Hosts remembered per process. The oldest entry goes when a long-lived crawler passes this many. */
const MAX_ROBOTS_HOSTS = 2_000;

const ROBOTS_CACHE = new Map<string, RobotsCacheEntry>();

/**
 * ROBOTS-DELAY-1: the site's own Crawl-delay for this host, while its robots.txt answer is current.
 * Read from the policy cache, so a delay the site drops expires with the answer that carried it.
 */
export function publishedCrawlDelayMs(hostname: string): number | null {
  const entry = ROBOTS_CACHE.get(hostname.toLowerCase());
  return entry && Date.now() < entry.expiresAt ? entry.crawlDelayMs : null;
}

/** Test seam. */
export function __clearRobotsCacheForTests(): void {
  ROBOTS_CACHE.clear();
}

/** The robots posture for this URL's own path, from one robots.txt fetch per host. */
async function resolveRobotsPolicy(url: string, config: ResolvedConfig): Promise<RobotsPolicy> {
  const parsedUrl = new URL(url);
  const host = parsedUrl.hostname.toLowerCase();
  const path = (parsedUrl.pathname || '/') + parsedUrl.search;
  const now = Date.now();

  let entry = ROBOTS_CACHE.get(host);
  if (!entry || now >= entry.expiresAt) {
    // Held in a mutable entry so the TTL can be set from the OUTCOME once it is
    // known, while concurrent callers still share the one in-flight request.
    const fresh: RobotsCacheEntry = { expiresAt: now + ROBOTS_FAILURE_TTL_MS, pending: Promise.resolve('unknown'), rules: null, crawlDelayMs: null };
    fresh.pending = evaluateRobotsForUrl(url, {
      userAgent: config.userAgent,
      dnsLookup: config.dnsLookup,
      onRules: (text) => {
        fresh.rules = text;
      },
    })
      .then((r) => {
        // 'unknown' from a real answer is still unresolved — retry it soon.
        fresh.expiresAt = Date.now() + (r.policy === 'unknown' ? ROBOTS_FAILURE_TTL_MS : ROBOTS_CACHE_TTL_MS);
        fresh.crawlDelayMs = r.crawlDelayMs;
        return r.policy;
      })
      // A robots fetch that itself fails leaves the posture unknown, which still
      // fails closed downstream — never upgrade a failure to 'allow'. But it
      // expires quickly, so the failure cannot become permanent.
      .catch(() => {
        fresh.expiresAt = Date.now() + ROBOTS_FAILURE_TTL_MS;
        return 'unknown' as const;
      });
    if (ROBOTS_CACHE.size >= MAX_ROBOTS_HOSTS) {
      const oldest = ROBOTS_CACHE.keys().next().value;
      if (oldest !== undefined) ROBOTS_CACHE.delete(oldest);
    }
    ROBOTS_CACHE.set(host, fresh);
    entry = fresh;
  }
  const policy = await entry.pending;
  // With the rules in hand every path is judged on its own: a Disallow below the base URL applies to it.
  return entry.rules === null ? policy : parseRobots(entry.rules, userAgentToken(config.userAgent), path).policy;
}

/**
 * Resolve a target's robots posture when the crawler is configured to.
 *
 * CRAWLSITE-AUTOROBOTS-1: crawlSite validates seeds before any lane runs, so
 * it needs the same resolution `crawl()` does internally. An explicit policy
 * is never overridden.
 */
export async function resolveTargetPolicy(target: CrawlTarget, config: ResolvedConfig, url = target.baseUrl): Promise<CrawlTarget> {
  if (!config.autoRobots || (target.robotsPolicy ?? 'unknown') !== 'unknown') return target;
  const policy = await resolveRobotsPolicy(URL.canParse(url) ? url : target.baseUrl, config);
  return { ...target, robotsPolicy: policy };
}

/**
 * VENDOR-POLICY-1: the lane-independent policy gate — eligibility, robots
 * posture, same-site. Governance is a property of the CRAWL, not of which
 * network makes the request, so `lanes: ['vendor']` is vetted like the own lane.
 *
 * Excludes the DNS-resolves-public check on purpose. That guards OUR socket
 * against SSRF, and in the vendor lane our machine never connects.
 *
 * Throws on refusal; callers convert to a `blocked` result.
 */
export async function approveCrawlPolicy(
  target: CrawlTarget,
  url: string,
  config: ResolvedConfig,
): Promise<{ requestUrl: URL; effectiveTarget: CrawlTarget }> {
  const effectiveTarget = await resolveTargetPolicy(target, config, url);
  assertTargetEligible(effectiveTarget);
  const requestUrl = assertRequestUrlAllowed(effectiveTarget, url);
  return { requestUrl, effectiveTarget };
}
