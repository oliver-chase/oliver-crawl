// ─── SSRF / same-site policy ────────────────────────────────────────────────
//
// Every fetch this package makes passes through here. It answers three
// questions, and refuses by throwing when any answer is no:
//
//   1. Is this target eligible to crawl at all?      (active, robots, https)
//   2. Is this URL on the target's own site?          (same-site, same-port)
//   3. Does its hostname resolve to a PUBLIC address? (DNS rebinding)
//
// (3) is the one that matters most and is easiest to get wrong: checking the
// URL's literal hostname is not enough, because an attacker controls DNS for
// a host they own and can point `totally-normal.example.com` at 127.0.0.1 or
// 169.254.169.254 (cloud instance metadata). So resolution is checked, every
// returned record is checked (not just the first), and the answer is cached
// only on SUCCESS — a transient resolver failure must not be able to poison
// a host permanently.
//
// Ported from a production crawler (Fallow, lib/ingestion/crawl-source-policy
// .ts) together with its 45-test suite. The one change is the input type:
// this takes CrawlTarget, not that app's 25-field database row.

import { getIpVersion, isBlockedHostname, isPrivateIpv4, isPrivateIpv6 } from '../core/net-address.js';
import type { CrawlTarget, DnsAddress, DnsLookupFn } from '../core/types.js';

type ValidatedBaseUrl = { url: URL; host: string; port: string };

/** Default DoH resolver. Overridable via config.dohEndpoint — see the note
 *  there on why this is a real choice, not an implementation detail. */
export const DEFAULT_DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

/**
 * Hosts proven to resolve publicly. Success-only.
 *
 * HOST-CACHE-SCOPE-1 (2026-07-27, found by live validation): this was a
 * single module-level Map shared by every crawler in the process. A host
 * validated by one crawler was therefore trusted by ALL of them — including
 * one deliberately configured with a different resolver. The live SSRF check
 * failed to block a host resolving to 127.0.0.1 purely because an earlier
 * check had already cached that hostname as safe.
 *
 * A resolver is part of a crawler's SECURITY configuration, so its verdicts
 * must not leak across instances that were configured differently. The cache
 * is now keyed per resolver identity; a crawler with its own dnsLookup gets
 * its own namespace, and the shared default keeps sharing (which is correct —
 * same resolver, same answer).
 */
const DNS_SAFE_HOST_CACHE = new Map<DnsLookupFn, Map<string, Promise<void>>>();

function cacheFor(lookupFn: DnsLookupFn): Map<string, Promise<void>> {
  let scoped = DNS_SAFE_HOST_CACHE.get(lookupFn);
  if (!scoped) {
    scoped = new Map();
    DNS_SAFE_HOST_CACHE.set(lookupFn, scoped);
  }
  return scoped;
}

/** Test seam — a long-lived process should never need this. */
export function __clearDnsCacheForTests(): void {
  DNS_SAFE_HOST_CACHE.clear();
}

export function assertPublicHost(hostname: string): void {
  if (isBlockedHostname(hostname)) {
    throw new Error(`Blocked non-public crawl host: ${hostname}`);
  }
}

function assertPublicResolvedAddress(address: string, family: number, hostname: string): void {
  if (family === 4 && isPrivateIpv4(address)) {
    throw new Error(`Blocked DNS resolution to private IPv4 for crawl host "${hostname}": ${address}`);
  }
  if (family === 6 && isPrivateIpv6(address)) {
    throw new Error(`Blocked DNS resolution to private IPv6 for crawl host "${hostname}": ${address}`);
  }
}

// ─── DNS over HTTPS fallback ────────────────────────────────────────────────
// Used when no dnsLookup is injected. DoH works on every runtime including
// edge/workerd, where node:dns does not exist.

type DohAnswer = { type?: number; data?: string };
type DohResponse = { Status?: number; Answer?: DohAnswer[] };

function parseDohResponse(payload: DohResponse): DnsAddress[] {
  if (!payload || payload.Status !== 0 || !Array.isArray(payload.Answer)) return [];
  return payload.Answer.flatMap((record) => {
    const family = record.type === 1 ? 4 : record.type === 28 ? 6 : 0;
    if (!record.data || family === 0) return [];
    return [{ address: record.data, family }];
  });
}

async function queryDnsType(hostname: string, type: 'A' | 'AAAA', endpoint: string): Promise<DnsAddress[]> {
  const resolver = new URL(endpoint);
  resolver.searchParams.set('name', hostname);
  resolver.searchParams.set('type', type);
  const response = await fetch(resolver, { headers: { accept: 'application/dns-json' }, cache: 'no-store' });
  if (!response.ok) throw new Error(`DNS resolver returned ${response.status} ${response.statusText}`);
  return parseDohResponse((await response.json()) as DohResponse);
}

/** Build a DoH-backed resolver for a given endpoint. */
export function createDohLookup(endpoint: string = DEFAULT_DOH_ENDPOINT): DnsLookupFn {
  return async (hostname) => {
    const [a, aaaa] = await Promise.all([queryDnsType(hostname, 'A', endpoint), queryDnsType(hostname, 'AAAA', endpoint)]);
    return [...a, ...aaaa];
  };
}

const defaultDnsLookup: DnsLookupFn = createDohLookup();

/**
 * Refuse a hostname that resolves anywhere private. THE anti-SSRF check.
 * Every returned record is inspected: a rebinding attack only needs one
 * internal answer in a multi-record reply.
 */
export async function assertHostResolvesToPublicAddress(
  hostname: string,
  lookupFn: DnsLookupFn = defaultDnsLookup,
): Promise<void> {
  assertPublicHost(hostname);

  const normalizedHost = hostname.toLowerCase();
  const cache = cacheFor(lookupFn);
  let pending = cache.get(normalizedHost);

  if (!pending) {
    pending = (async () => {
      let records: DnsAddress[] = [];
      try {
        records = await lookupFn(normalizedHost);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`DNS lookup failed for crawl host "${hostname}": ${detail}`);
      }

      if (!records.length) {
        throw new Error(`DNS lookup returned no addresses for crawl host "${hostname}"`);
      }

      for (const record of records) {
        if (getIpVersion(record.address) === 0) {
          throw new Error(`DNS lookup returned invalid address for crawl host "${hostname}": ${record.address}`);
        }
        assertPublicResolvedAddress(record.address, record.family, hostname);
      }
    })();

    cache.set(normalizedHost, pending);
  }

  try {
    await pending;
  } catch (error) {
    // Never cache a failure: one transient SERVFAIL would otherwise blacklist
    // a legitimate host for the life of the process.
    cache.delete(normalizedHost);
    throw error;
  }
}

function validateBaseUrl(target: CrawlTarget): ValidatedBaseUrl {
  let baseUrl: URL;
  try {
    baseUrl = new URL(target.baseUrl);
  } catch {
    throw new Error(`Invalid target baseUrl for crawl policy: ${target.baseUrl}`);
  }

  if (baseUrl.protocol !== 'https:') {
    throw new Error(`Only https targets are allowed for secure crawl: ${target.baseUrl}`);
  }
  if (baseUrl.username || baseUrl.password) {
    throw new Error(`Credentialed URLs are not allowed in crawl policy: ${target.baseUrl}`);
  }

  assertPublicHost(baseUrl.hostname);

  return { url: baseUrl, host: baseUrl.hostname.toLowerCase(), port: baseUrl.port || '' };
}

/** Eligibility, before any network call. Robots posture is decided by the
 *  CONSUMER and enforced here; 'unknown' fails closed. */
export function assertTargetEligible(target: CrawlTarget): void {
  if (target.active === false) {
    throw new Error(`Target "${target.name || target.baseUrl}" is inactive and cannot be crawled.`);
  }
  const robots = target.robotsPolicy ?? 'unknown';
  if (robots === 'disallow') {
    throw new Error(`Target "${target.name || target.baseUrl}" is disallowed by robots policy.`);
  }
  if (robots === 'unknown') {
    throw new Error(`Target "${target.name || target.baseUrl}" has an unknown robots policy — refusing to crawl (fail closed).`);
  }
  validateBaseUrl(target);
}

// A host and its apex/www counterpart are the same site. This is the single
// most common in-page link and redirect shape (example.com <-> www.example
// .com); treating them as different hosts breaks crawling a site with its own
// links. Nothing broader is allowed — a subdomain is NOT the same site.
function hostsMatchAllowingWww(a: string, b: string): boolean {
  const norm = (host: string) => host.toLowerCase().replace(/^www\./, '');
  return a.toLowerCase() === b.toLowerCase() || norm(a) === norm(b);
}

/** Same-site enforcement for a URL the crawler intends to REQUEST. */
export function assertRequestUrlAllowed(target: CrawlTarget, requestUrl: string): URL {
  const base = validateBaseUrl(target);

  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    throw new Error(`Invalid crawl URL: ${requestUrl}`);
  }

  if (parsed.protocol !== 'https:') throw new Error(`Blocked non-https crawl URL: ${requestUrl}`);
  if (parsed.username || parsed.password) throw new Error(`Blocked credentialed crawl URL: ${requestUrl}`);
  assertPublicHost(parsed.hostname);

  if (!hostsMatchAllowingWww(parsed.hostname, base.host)) {
    throw new Error(`Blocked off-domain crawl URL: ${requestUrl}`);
  }
  if ((parsed.port || '') !== base.port) {
    throw new Error(`Blocked cross-port crawl URL: ${requestUrl}`);
  }

  return parsed;
}

/** Same guarantees, for a redirect the origin asked us to FOLLOW. */
export function assertRedirectUrlAllowed(target: CrawlTarget, requestUrl: string): URL {
  const base = validateBaseUrl(target);
  return assertRedirectUrlAllowedForHost(base.host, base.port, requestUrl);
}

/** URL-level core, for call sites holding only a host (no target record). */
export function assertRedirectUrlAllowedForHost(baseHost: string, basePort: string, requestUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    throw new Error(`Invalid redirect URL: ${requestUrl}`);
  }

  if (parsed.protocol !== 'https:') throw new Error(`Blocked non-https redirect URL: ${requestUrl}`);
  if (parsed.username || parsed.password) throw new Error(`Blocked credentialed redirect URL: ${requestUrl}`);
  assertPublicHost(parsed.hostname);
  if (!hostsMatchAllowingWww(parsed.hostname, baseHost.toLowerCase())) {
    throw new Error(`Blocked off-domain redirect URL: ${requestUrl}`);
  }
  if ((parsed.port || '') !== basePort) throw new Error(`Blocked cross-port redirect URL: ${requestUrl}`);

  return parsed;
}
