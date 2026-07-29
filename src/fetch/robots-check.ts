// ─── Robots re-check: turn a stale/guessed robots_policy into a real one ────
//
// A source's robots_policy is otherwise static (seeded or hand-set), and the
// crawl gate fail-closes on 'unknown' — so a source whose robots.txt was never
// actually fetched (or whose fetch hiccuped once) sits blocked forever even
// when the site plainly allows crawlers. This module fetches robots.txt for
// real, as the configured user agent, and decides. It's the auto-fix behind:
//   - the per-row / bulk "Re-check robots" admin action, and
//   - the self-heal step on the crawl path (auto-recheck an 'unknown' source
//     once before giving up on it).
//
// Fail-closed: ANY fetch/parse failure returns 'unknown' (never a false
// 'allow') — a site actively blocking this crawler's request stays blocked, which
// is the honest outcome. A missing robots.txt (404) is 'allow' per the
// standard. Matches the caller's own user-agent group first, then '*'.

import { assertHostResolvesToPublicAddress } from './host-policy.js';
import { DEFAULT_USER_AGENT } from '../core/config.js';
import type { DnsLookupFn } from '../core/types.js';

export type RobotsPolicy = 'allow' | 'disallow' | 'conditional' | 'unknown';
export type RobotsCheckResult = {
  policy: RobotsPolicy;
  reason: string;
  /**
   * ROBOTS-DELAY-1: the site's own `Crawl-delay`, in ms, when it
   * published one. Null when absent.
   *
   * This is the origin stating, in the one machine-readable place it has, how
   * fast it is willing to be crawled. Parsing robots.txt for permission and
   * then ignoring its pacing is taking the half of the file that suits us —
   * and it is a common way to get blocked by a site that technically allowed
   * you.
   */
  crawlDelayMs: number | null;
};

/**
 * Ceiling on a published Crawl-delay. Some sites publish absurd values
 * (86400 = one day), which would stall a crawl indefinitely rather than slow
 * it politely. Above this we treat the site as effectively refusing frequent
 * crawling and let the caller's own pacing govern.
 */
export const MAX_HONORED_CRAWL_DELAY_MS = 30_000;

const ROBOTS_TIMEOUT_MS = 8_000;
const ROBOTS_MAX_BYTES = 512_000;
const MAX_ROBOTS_REDIRECTS = 4;
// The crawler's own product token, lowercased — a robots
// `User-agent: <token>` group matches this; anything else falls through to
// `*`. Derived from the caller's configured User-Agent rather than a
// hardcoded name, so a consumer's robots identity actually matches the UA it
// sends. "MyBot/1.0 (+https://...)" -> "mybot".
/**
 * Same-site test for a robots.txt redirect. `www.` is ignored, since apex-to-
 * www is a normal hosting redirect and the same operator controls both.
 * Deliberately strict otherwise: a subdomain is a different publisher often
 * enough that inheriting its policy would be a guess.
 */
function isSameRegistrableHost(a: string, b: string): boolean {
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, '');
  return strip(a) === strip(b);
}

export function userAgentToken(userAgent: string): string {
  return (userAgent.split('/')[0] || userAgent).trim().toLowerCase();
}

export async function evaluateRobotsForUrl(
  rawUrl: string,
  opts?: { fetchImpl?: typeof fetch; userAgent?: string; dnsLookup?: DnsLookupFn },
): Promise<RobotsCheckResult> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const userAgent = opts?.userAgent ?? DEFAULT_USER_AGENT;
  let target: URL;
  let robotsUrl: URL;
  try {
    target = new URL(rawUrl);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return { policy: 'unknown', reason: 'source URL is not http(s)', crawlDelayMs: null };
    }
    robotsUrl = new URL('/robots.txt', target.origin);
  } catch {
    return { policy: 'unknown', reason: 'source URL is invalid', crawlDelayMs: null };
  }

  try {
    // Same SSRF/DNS-rebinding guard every direct-fetch call site uses.
    await assertHostResolvesToPublicAddress(target.hostname, opts?.dnsLookup);
  } catch {
    return { policy: 'unknown', reason: 'host does not resolve to a public address', crawlDelayMs: null };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ROBOTS_TIMEOUT_MS);
  let body: string;
  // Recorded so a consumer can notice a source has moved — a redirect to
  // another domain is usually a rename worth updating in their registry.
  let redirectedOffDomainTo: string | null = null;
  try {
    // Follow redirects MANUALLY, re-validating every hop's host for SSRF —
    // http→https and apex↔www redirects on robots.txt are the norm (Beak &
    // Skiff's 301 was killing an otherwise-crawlable source), but `follow`
    // would fetch each hop before any host on the chain is validated.
    let currentUrl = robotsUrl;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_ROBOTS_REDIRECTS; hop += 1) {
      res = await doFetch(currentUrl.toString(), {
        method: 'GET',
        headers: { 'User-Agent': userAgent, accept: 'text/plain' },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (res.status < 300 || res.status >= 400) break;
      const location = res.headers.get('location');
      if (!location || hop === MAX_ROBOTS_REDIRECTS) {
        return { policy: 'unknown', reason: `robots.txt redirected (${res.status}) too many times — inconclusive`, crawlDelayMs: null };
      }
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        return { policy: 'unknown', reason: 'robots.txt redirect target is not a valid URL', crawlDelayMs: null };
      }
      if (next.protocol !== 'https:' && next.protocol !== 'http:') {
        return { policy: 'unknown', reason: 'robots.txt redirected to a non-http(s) URL', crawlDelayMs: null };
      }
      // ROBOTS-REDIRECT-1: an off-domain robots.txt redirect is
      // FOLLOWED, and the reason records where it went.
      //
      // The first version of this refused them, reasoning that a stranger's
      // robots.txt must not govern our target — prompted by an expired source
      // whose robots.txt 301s to a domain-parking service.
      //
      // Measuring that against 60 live sources reversed the decision: it
      // blocked six working sources to stop one parked domain. All six were
      // ordinary domain migrations (a gallery rebrand, .org to .gov, a resort
      // renamed), and in every case the 301 was configured BY the operator of
      // the old domain. That redirect is their statement, not a hijack of it.
      //
      // The parked-domain case is real but is not a robots problem: whoever
      // holds the domain now genuinely does control its policy, and the page
      // itself comes back as a thin sales lander that `likelyEmptyState` and a
      // low text length already expose. Refusing at the robots layer cost far
      // more than it protected.
      const domainChanged = !isSameRegistrableHost(currentUrl.hostname, next.hostname);
      if (domainChanged) redirectedOffDomainTo = next.hostname;
      try {
        await assertHostResolvesToPublicAddress(next.hostname, opts?.dnsLookup);
      } catch {
        return { policy: 'unknown', reason: 'robots.txt redirected to a non-public host', crawlDelayMs: null };
      }
      currentUrl = next;
    }
    if (!res) {
      return { policy: 'unknown', reason: 'robots.txt could not be fetched', crawlDelayMs: null };
    }
    // ROBOTS-4XX-1: RFC 9309 §2.3.1.3 — "If the crawler receives a 4xx status
    // code, the crawler MAY access any resources." The file is UNAVAILABLE,
    // and a 403 is equivalent to a 404 for that purpose.
    //
    // This previously allowed only 404/410 and treated every other 4xx as
    // unknown, which fails closed. Measured against 60 live sources, that
    // refused four of them outright — and each read fine once permitted,
    // because the robots fetch was the only thing failing. Being stricter
    // than the standard here cost data and protected nobody: a site that has
    // not published a robots.txt has not expressed a restriction.
    //
    // 429 is deliberately excluded. It means rate limited, not unavailable,
    // and reading it as permission is how a temporary block becomes a ban.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      return {
        policy: 'allow',
        reason: `robots.txt unavailable (HTTP ${res.status}) — RFC 9309 treats 4xx as no restrictions`,
        crawlDelayMs: null,
      };
    }
    // 5xx and anything else: the standard says assume complete disallow.
    if (!res.ok) {
      // WHITE-LABEL-2: this named one vendor's bot regardless of the
      // caller's actual user agent — wrong output for every other consumer.
      return {
        policy: 'unknown',
        reason: `robots.txt fetch returned ${res.status} — the site may be blocking this crawler`,
        crawlDelayMs: null,
      };
    }
    body = (await res.text()).slice(0, ROBOTS_MAX_BYTES);
  } catch {
    return { policy: 'unknown', reason: 'robots.txt fetch failed or timed out (the site may be blocking the crawler)', crawlDelayMs: null };
  } finally {
    clearTimeout(timeoutId);
  }

  const parsed = parseRobots(body, userAgentToken(userAgent), target.pathname || '/');
  return redirectedOffDomainTo
    ? { ...parsed, reason: `${parsed.reason} (robots.txt now served from ${redirectedOffDomainTo} — this source may have moved)` }
    : parsed;
}

type RobotsGroup = { allows: string[]; disallows: string[]; crawlDelayMs: number | null };

// Minimal, standards-shaped robots.txt evaluator. Groups rules by user-agent,
// picks the caller's own user-agent group over '*', then applies longest-match
// Allow/Disallow to the path (Allow wins ties, per Google's spec). Crawl-delay
// IS read and honoured (ROBOTS-DELAY-1). Other non-standard directives
// (Sitemap, Content-Signal) are ignored. Exported for tests.
export function parseRobots(text: string, uaToken: string, path: string): RobotsCheckResult {
  const groups = new Map<string, RobotsGroup>();
  let currentAgents: string[] = [];
  let sawDirectiveSinceAgent = false;

  const ensure = (agent: string): RobotsGroup => {
    const key = agent.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { allows: [], disallows: [], crawlDelayMs: null };
      groups.set(key, group);
    }
    return group;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!value) continue;
      // Consecutive User-agent lines (no directive between) share one group.
      if (sawDirectiveSinceAgent) {
        currentAgents = [];
        sawDirectiveSinceAgent = false;
      }
      currentAgents.push(value.toLowerCase());
      ensure(value);
    } else if (field === 'crawl-delay') {
      sawDirectiveSinceAgent = true;
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) {
        for (const agent of currentAgents) {
          ensure(agent).crawlDelayMs = Math.min(Math.round(seconds * 1000), MAX_HONORED_CRAWL_DELAY_MS);
        }
      }
    } else if (field === 'allow' || field === 'disallow') {
      sawDirectiveSinceAgent = true;
      // A directive before any User-agent line has no group — ignore it.
      for (const agent of currentAgents) {
        const group = ensure(agent);
        if (field === 'allow') group.allows.push(value);
        else group.disallows.push(value);
      }
    }
  }

  let group: RobotsGroup | undefined;
  for (const [agent, candidate] of groups) {
    if (agent && agent !== '*' && uaToken.includes(agent)) {
      group = candidate;
      break;
    }
  }
  if (!group) group = groups.get('*');
  if (!group) {
    return { policy: 'allow', reason: 'robots.txt has no rule for this crawler or * — crawling allowed', crawlDelayMs: null };
  }

  const matchLen = (rule: string): number => (robotsRuleMatch(rule, path) ? rule.replace(/[*$]/g, '').length : -1);
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const allow of group.allows) {
    if (allow === '') continue; // empty Allow has no effect
    bestAllow = Math.max(bestAllow, matchLen(allow));
  }
  for (const disallow of group.disallows) {
    if (disallow === '') continue; // empty Disallow = "allow everything"
    bestDisallow = Math.max(bestDisallow, matchLen(disallow));
  }

  if (bestDisallow === -1) {
    return { policy: 'allow', reason: 'robots.txt permits this path for this crawler', crawlDelayMs: group.crawlDelayMs };
  }
  if (bestAllow >= bestDisallow) {
    return { policy: 'allow', reason: 'robots.txt Allow rule overrides the Disallow for this path', crawlDelayMs: group.crawlDelayMs };
  }
  return { policy: 'disallow', reason: 'robots.txt disallows this path for this crawler', crawlDelayMs: group.crawlDelayMs };
}

// Robots path pattern → regex: '*' is any run of chars, trailing '$' anchors
// the end. Everything else is matched literally (regex metachars escaped).
function robotsRuleMatch(rule: string, path: string): boolean {
  let pattern = rule;
  let anchoredEnd = false;
  if (pattern.endsWith('$')) {
    anchoredEnd = true;
    pattern = pattern.slice(0, -1);
  }
  const escaped = pattern
    .split('*')
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  try {
    return new RegExp(`^${escaped}${anchoredEnd ? '$' : ''}`).test(path);
  } catch {
    return false;
  }
}
