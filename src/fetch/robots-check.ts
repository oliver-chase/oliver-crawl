// ─── Robots re-check: turn a stale/guessed robots_policy into a real one ────
//
// A source's robots_policy is otherwise static (seeded or hand-set), and the
// crawl gate fail-closes on 'unknown' — so a source whose robots.txt was never
// actually fetched (or whose fetch hiccuped once) sits blocked forever even
// when the site plainly allows crawlers. This module fetches robots.txt for
// real, as FallowBot, and decides. It's the auto-fix behind:
//   - the per-row / bulk "Re-check robots" admin action, and
//   - the self-heal step on the crawl path (auto-recheck an 'unknown' source
//     once before giving up on it).
//
// Fail-closed: ANY fetch/parse failure returns 'unknown' (never a false
// 'allow') — a site actively blocking FallowBot's request stays blocked, which
// is the honest outcome. A missing robots.txt (404) is 'allow' per the
// standard. Matches FallowBot's own group first, then '*'.

import { assertHostResolvesToPublicAddress } from './host-policy.js';
import { DEFAULT_USER_AGENT } from '../core/config.js';
import type { DnsLookupFn } from '../core/types.js';

export type RobotsPolicy = 'allow' | 'disallow' | 'conditional' | 'unknown';
export type RobotsCheckResult = { policy: RobotsPolicy; reason: string };

const ROBOTS_TIMEOUT_MS = 8_000;
const ROBOTS_MAX_BYTES = 512_000;
const MAX_ROBOTS_REDIRECTS = 4;
// The crawler's own product token, lowercased — a robots
// `User-agent: <token>` group matches this; anything else falls through to
// `*`. Derived from the caller's configured User-Agent rather than a
// hardcoded name, so a consumer's robots identity actually matches the UA it
// sends. "MyBot/1.0 (+https://...)" -> "mybot".
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
      return { policy: 'unknown', reason: 'source URL is not http(s)' };
    }
    robotsUrl = new URL('/robots.txt', target.origin);
  } catch {
    return { policy: 'unknown', reason: 'source URL is invalid' };
  }

  try {
    // Same SSRF/DNS-rebinding guard every direct-fetch call site uses.
    await assertHostResolvesToPublicAddress(target.hostname, opts?.dnsLookup);
  } catch {
    return { policy: 'unknown', reason: 'host does not resolve to a public address' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ROBOTS_TIMEOUT_MS);
  let body: string;
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
        return { policy: 'unknown', reason: `robots.txt redirected (${res.status}) too many times — inconclusive` };
      }
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        return { policy: 'unknown', reason: 'robots.txt redirect target is not a valid URL' };
      }
      if (next.protocol !== 'https:' && next.protocol !== 'http:') {
        return { policy: 'unknown', reason: 'robots.txt redirected to a non-http(s) URL' };
      }
      try {
        await assertHostResolvesToPublicAddress(next.hostname, opts?.dnsLookup);
      } catch {
        return { policy: 'unknown', reason: 'robots.txt redirected to a non-public host' };
      }
      currentUrl = next;
    }
    if (!res) {
      return { policy: 'unknown', reason: 'robots.txt could not be fetched' };
    }
    // No robots.txt at all = crawling allowed (standard interpretation).
    if (res.status === 404 || res.status === 410) {
      return { policy: 'allow', reason: 'no robots.txt (site returns 404) — crawling allowed by default' };
    }
    if (!res.ok) {
      return { policy: 'unknown', reason: `robots.txt fetch returned ${res.status} — likely the site is blocking FallowBot` };
    }
    body = (await res.text()).slice(0, ROBOTS_MAX_BYTES);
  } catch {
    return { policy: 'unknown', reason: 'robots.txt fetch failed or timed out (the site may be blocking the crawler)' };
  } finally {
    clearTimeout(timeoutId);
  }

  return parseRobots(body, userAgentToken(userAgent), target.pathname || '/');
}

type RobotsGroup = { allows: string[]; disallows: string[] };

// Minimal, standards-shaped robots.txt evaluator. Groups rules by user-agent,
// picks FallowBot's group over '*', then applies longest-match Allow/Disallow
// to the path (Allow wins ties, per Google's spec). Non-standard directives
// (Sitemap, Content-Signal, Crawl-delay, etc.) are ignored. Exported for tests.
export function parseRobots(text: string, uaToken: string, path: string): RobotsCheckResult {
  const groups = new Map<string, RobotsGroup>();
  let currentAgents: string[] = [];
  let sawDirectiveSinceAgent = false;

  const ensure = (agent: string): RobotsGroup => {
    const key = agent.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { allows: [], disallows: [] };
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
    return { policy: 'allow', reason: 'robots.txt has no rule for FallowBot or * — crawling allowed' };
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
    return { policy: 'allow', reason: 'robots.txt permits this path for FallowBot' };
  }
  if (bestAllow >= bestDisallow) {
    return { policy: 'allow', reason: 'robots.txt Allow rule overrides the Disallow for this path' };
  }
  return { policy: 'disallow', reason: 'robots.txt disallows this path for FallowBot' };
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
