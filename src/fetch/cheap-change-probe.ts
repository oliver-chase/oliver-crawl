// ─── Cheap pre-fetch change probe ───────────────────────────────────────────
//
// A GET that reads ETag/Last-Modified without pulling the page when the origin
// sends them, and a capped body hash when it does not, so an unchanged page can
// be skipped before it costs a full fetch.
//
// Redirects are followed MANUALLY, re-validating each hop: `follow` would
// fetch every intermediate before any host on the chain was checked. Bailing
// on redirects instead — the original behaviour — returned null for every
// redirecting source, so their validators were never read and each paid for a
// full re-crawl every tick.

import { pooledFetchFor } from './connection-pool.js';
import {
  assertHostResolvesToPublicAddress,
  assertRequestUrlAllowed,
  assertTargetEligible,
  assertRedirectUrlAllowed,
} from './host-policy.js';
import { sha256Hex } from '../core/hash.js';
import { dropBody, followManualRedirects, readBytesPrefix } from './http-mechanics.js';
import { DEFAULT_USER_AGENT } from '../core/config.js';
import type { DnsLookupFn, CrawlTarget } from '../core/types.js';

/** A cheap "has this page changed" fingerprint. Cheaper than a full crawl by
 *  orders of magnitude: a HEAD/ranged GET and a hash, no parsing, no LLM. */
export type CheapChangeSignal = {
  etag: string | null;
  lastModified: string | null;
  bodyHash: string | null;
};



const PROBE_TIMEOUT_MS = 8_000;
const PROBE_MAX_REDIRECTS = 4;
const PROBE_MAX_BODY_BYTES = 200_000; // enough to hash a shell page, not a full render

/**
 * A plain, unauthenticated, bounded GET — never routed through the paid
 * render service or Apify. Reuses the same per-source URL policy guard
 * (SSRF/host/legal-tier) the real crawl uses. Returns null on ANY failure —
 * see module header on why null must never be treated as "unchanged."
 */
export async function probeCheapChangeSignal(
  source: CrawlTarget,
  url: string,
  // PROBE-DNS-SEAM-1: injectable, like every other fetch path here. Without
  // it this function's success path could only be exercised against real DNS,
  // so it was the one public entry point with no unit-testable happy path.
  opts?: { dnsLookup?: DnsLookupFn },
): Promise<CheapChangeSignal | null> {
  let safeUrl: URL;
  try {
    assertTargetEligible(source);
    safeUrl = assertRequestUrlAllowed(source, url);
    // Static string checks alone don't catch DNS rebinding (a hostname
    // that reads as public but resolves to a private address) — the same
    // resolution check every other direct-fetch call site in this repo
    // applies before fetching.
    await assertHostResolvesToPublicAddress(safeUrl.hostname, opts?.dnsLookup);
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    // Redirects are followed by hand, each hop validated same-site https and publicly resolved
    // (PROBE-DNS-SEAM-1: the caller's resolver applies on every hop). Bailing on a redirect made the
    // probe return null for every apex to www source, so unchanged sources paid for a full re-crawl.
    const walk = await followManualRedirects(safeUrl, {
      doFetch: pooledFetchFor(opts?.dnsLookup),
      maxHops: PROBE_MAX_REDIRECTS,
      init: () => ({ method: 'GET', headers: { 'User-Agent': DEFAULT_USER_AGENT }, signal: controller.signal }),
      onRedirect: async (location, from) => {
        const next = assertRedirectUrlAllowed(source, new URL(location, from).toString());
        await assertHostResolvesToPublicAddress(next.hostname, opts?.dnsLookup);
        return next;
      },
    });
    if (walk.stopped) {
      dropBody(walk.response);
      return null;
    }
    const response: Response = walk.response;

    if (response.status < 200 || response.status >= 300) {
      return null;
    }

    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');

    // Only pay for the body-hash fallback when neither header is present —
    // most static/server-rendered pages send one of these, and reading a
    // capped body is cheap either way.
    let bodyHash: string | null = null;
    if (!etag && !lastModified) {
      // A body that cannot be read leaves the hash null, because two failed reads would otherwise match.
      // A body past the cap could differ only after it, so a capped read gives no hash to compare, and such a
      // page with no validators is always fetched. That costs a fetch and never misses a change.
      const read = await readBytesPrefix(response, PROBE_MAX_BODY_BYTES).catch(() => null);
      bodyHash = read === null || read.capped ? null : await sha256Hex(read.bytes);
    } else {
      dropBody(response);
    }

    return { etag, lastModified, bodyHash };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * True ONLY when both sides have a real, comparable signal that matches.
 * Strong signals (etag, then lastModified) are checked first; body hash is
 * the last resort, and only when it's present on both sides too.
 */
export function cheapSignalsMatch(prior: CheapChangeSignal | null | undefined, current: CheapChangeSignal | null): boolean {
  if (!prior || !current) return false;
  if (prior.etag && current.etag) return prior.etag === current.etag;
  if (prior.lastModified && current.lastModified) return prior.lastModified === current.lastModified;
  if (prior.bodyHash && current.bodyHash) return prior.bodyHash === current.bodyHash;
  return false;
}
