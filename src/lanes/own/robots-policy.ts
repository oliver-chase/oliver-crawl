// ─── Robots posture for the own lane ────────────────────────────────────────
//
// Resolving a target's robots posture, caching it per host, and the policy approval every crawl runs first.

import { assertRequestUrlAllowed, assertTargetEligible } from '../../fetch/host-policy.js';
import { evaluateRobotsForUrl, type RobotsPolicy } from '../../fetch/robots-check.js';
import type { ResolvedConfig } from '../../core/config.js';
import type { CrawlTarget } from '../../core/types.js';

// CRAWL-ROBOTS-1: robots.txt was ported but nothing ever CALLED it, so a
// "governed crawler" was only as governed as the consumer's bookkeeping. With
// config.autoRobots on, an 'unknown' posture is resolved for real and cached per
// HOST — one robots.txt request per host, not per page.
//
// ROBOTS-TTL-1: that cache had no expiry, and this comment once claimed
// long-lived processes never needed one — exactly backwards, since a long-lived
// process is the only place it matters. It broke both ways. A site ADDING a
// Disallow after we cached 'allow' kept being crawled for the life of the
// process, which is the one thing robots compliance exists to prevent. Worse, a
// transient failure cached 'unknown' permanently, and since unknown fails closed
// a single network blip meant that host never crawled again, silently.
//
// The two TTLs are deliberately asymmetric: a successful answer is cheap to
// trust for hours, a failure must be retried soon, because the cost of holding
// it is a host that silently stops working.
export const ROBOTS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — resolved posture
export const ROBOTS_FAILURE_TTL_MS = 5 * 60 * 1000; //     5m — unresolved, retry soon

type RobotsPolicyValue = RobotsPolicy;
type RobotsCacheEntry = { pending: Promise<RobotsPolicyValue>; expiresAt: number };

/** Hosts remembered per process. The oldest entry goes when a long-lived crawler passes this many. */
const MAX_ROBOTS_HOSTS = 2_000;

const ROBOTS_CACHE = new Map<string, RobotsCacheEntry>();

function evictOldest(map: Map<string, unknown>): void {
  if (map.size < MAX_ROBOTS_HOSTS) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

// ROBOTS-DELAY-1: a site's published Crawl-delay, per host, learned whenever
// robots.txt is resolved. Kept beside the policy cache and not threaded
// through every call, because the throttle runs at a different point in the
// request than the policy check does.
const ROBOTS_DELAY_MS = new Map<string, number>();

/** The site's own Crawl-delay for this host, if we have seen its robots.txt. */
export function publishedCrawlDelayMs(hostname: string): number | null {
  return ROBOTS_DELAY_MS.get(hostname.toLowerCase()) ?? null;
}

/** Test seam. */
export function __clearRobotsCacheForTests(): void {
  ROBOTS_CACHE.clear();
  ROBOTS_DELAY_MS.clear();
}

async function resolveRobotsPolicy(url: string, config: ResolvedConfig): Promise<RobotsPolicyValue> {
  const host = new URL(url).hostname.toLowerCase();
  const now = Date.now();

  const hit = ROBOTS_CACHE.get(host);
  if (hit && now < hit.expiresAt) return hit.pending;

  // Held in a mutable entry so the TTL can be set from the OUTCOME once it is
  // known, while concurrent callers still share the one in-flight request.
  const entry: RobotsCacheEntry = {
    expiresAt: now + ROBOTS_FAILURE_TTL_MS,
    pending: Promise.resolve('unknown'),
  };

  entry.pending = evaluateRobotsForUrl(url, { userAgent: config.userAgent, dnsLookup: config.dnsLookup })
    .then((r) => {
      // 'unknown' from a real answer is still unresolved — retry it soon.
      entry.expiresAt = Date.now() + (r.policy === 'unknown' ? ROBOTS_FAILURE_TTL_MS : ROBOTS_CACHE_TTL_MS);
      if (r.crawlDelayMs !== null) {
        evictOldest(ROBOTS_DELAY_MS);
        ROBOTS_DELAY_MS.set(host, r.crawlDelayMs);
      }
      return r.policy;
    })
    // A robots fetch that itself fails leaves the posture unknown, which still
    // fails closed downstream — never upgrade a failure to 'allow'. But it
    // expires quickly, so the failure cannot become permanent.
    .catch(() => {
      entry.expiresAt = Date.now() + ROBOTS_FAILURE_TTL_MS;
      return 'unknown' as const;
    });

  evictOldest(ROBOTS_CACHE);
  ROBOTS_CACHE.set(host, entry);
  return entry.pending;
}

/**
 * Resolve a target's robots posture when the crawler is configured to.
 *
 * CRAWLSITE-AUTOROBOTS-1: crawlSite validates seeds before any lane runs, so
 * it needs the same resolution `crawl()` does internally. An explicit policy
 * is never overridden.
 */
export async function resolveTargetPolicy(target: CrawlTarget, config: ResolvedConfig): Promise<CrawlTarget> {
  if (!config.autoRobots || (target.robotsPolicy ?? 'unknown') !== 'unknown') return target;
  const policy = await resolveRobotsPolicy(target.baseUrl, config);
  return { ...target, robotsPolicy: policy };
}

/**
 * VENDOR-POLICY-1: the lane-independent policy gate — eligibility, robots
 * posture, same-site. Governance is a property of the CRAWL, not of which
 * network makes the request: before this, `lanes: ['vendor']` ran with no
 * vetting at all.
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
  const effectiveTarget = await resolveTargetPolicy(target, config);
  assertTargetEligible(effectiveTarget);
  const requestUrl = assertRequestUrlAllowed(effectiveTarget, url);
  return { requestUrl, effectiveTarget };
}
