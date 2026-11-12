// ─── SSRF-guarded fetch for discovery URLs ──────────────────────────────────
//
// Sitemap and pagination discovery fetch URLs that the origin published, so every hop is validated
// before a request goes to it: public address, http(s) only, and the target's own site when known.

import { assertHostResolvesToPublicAddress, hostsMatchAllowingWww } from './host-policy.js';
import { followManualRedirects } from './http-mechanics.js';
import type { DnsLookupFn } from '../core/types.js';
import { DEFAULT_USER_AGENT } from '../core/config.js';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;

/**
 * SSRF-guarded fetch that follows redirects manually, re-validating each hop.
 *
 * SAFEFETCH-PARITY-1: this claimed "same discipline as robots-check /
 * cheap-change-probe" and was weaker than both. It re-resolved each hop's host
 * but accepted ANY host, so a discovery URL could redirect off-site and be
 * followed; and it took no injectable resolver, so a crawler running its own
 * DNS had it bypassed here entirely.
 *
 * Both are closed. A redirect stays on the starting URL's site, or on `sameSiteAs`
 * when the caller names the target's site. `dnsLookup` is threaded like every other fetch path.
 *
 * `http:` is still accepted here, unlike the crawl path. Feed and sitemap URLs
 * are frequently published as http even by sites served over https, and
 * refusing them would drop real feeds; the public-address check is what makes
 * that safe.
 */
export async function safeFetch(
  rawUrl: string,
  doFetch: typeof fetch,
  accept: string,
  opts?: { sameSiteAs?: string; dnsLookup?: DnsLookupFn; userAgent?: string; timeoutMs?: number },
): Promise<Response | null> {
  let current: URL;
  try {
    current = new URL(rawUrl);
    if (current.protocol !== 'https:' && current.protocol !== 'http:') return null;
  } catch {
    return null;
  }
  // The signal stays armed after this function returns, so the caller's body read has the same bound.
  const signal = AbortSignal.timeout(opts?.timeoutMs ?? FETCH_TIMEOUT_MS);
  // A redirect stays on the site it started from unless the caller names another.
  const siteHost = new URL(opts?.sameSiteAs ?? current.toString()).hostname;
  try {
    await assertHostResolvesToPublicAddress(current.hostname, opts?.dnsLookup);
    const walk = await followManualRedirects(current, {
      doFetch,
      maxHops: MAX_REDIRECTS,
      init: () => ({ method: 'GET', headers: { 'User-Agent': opts?.userAgent ?? DEFAULT_USER_AGENT, accept }, signal }),
      onRedirect: async (location, from) => {
        const next = new URL(location, from);
        if (next.protocol !== 'https:' && next.protocol !== 'http:') throw new Error('not http(s)');
        // A redirect may not move to another explicit port, the same rule the crawl path applies.
        if ((next.port || '') !== (from.port || '')) throw new Error('cross-port redirect');
        // SAFEFETCH-PARITY-1: a redirect may not leave the target's site.
        if (!hostsMatchAllowingWww(next.hostname, siteHost)) {
          throw new Error('off-site redirect');
        }
        await assertHostResolvesToPublicAddress(next.hostname, opts?.dnsLookup);
        return next;
      },
    });
    return walk.stopped ? null : walk.response;
  } catch {
    return null;
  }
}
