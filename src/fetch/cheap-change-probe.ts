// ─── C10: cheap change-detection gate ahead of paid crawls ─────────────────
//
// The `html` lane already skips its LLM extraction cost on an unchanged-page
// hash (source-reference-upsert.ts's findUnchangedUrls) — but that check
// happens AFTER the (cheap) Cheerio fetch. The `browser` lane is different:
// the EXPENSIVE step (a paid headless render) is the fetch itself, so the
// only way to save money is to check BEFORE it, not after.
//
// EPIC-1 S5 already found that hashing a JS-hydrated page's plain-fetched
// PRE-RENDER shell is unsound — the shell can be byte-identical while the
// rendered content changed (that's the whole reason a source is on the
// browser lane). So this probe prefers a server-declared strong signal
// (ETag / Last-Modified) and treats a body hash as a weaker, best-effort
// fallback used ONLY when neither header is present on either side. Any
// probe failure (network error, timeout, non-2xx, a redirect) returns
// null — callers must treat null as "unknown," never as "unchanged."
// Failing open (crawl anyway) costs a render fee; failing closed (skip
// anyway) can silently stop refreshing a source forever. Only the former
// is acceptable.
//
// NOT wired into the `instagram` lane (code review, 2026-07-11): Instagram
// serves a largely static/generic shell to unauthenticated requests — the
// whole reason that lane pays for Apify instead of fetching directly — so
// its ETag/Last-Modified/body-hash would stay identical regardless of real
// new posts, guaranteeing exactly the fail-closed-forever failure this
// module exists to avoid. See lib/ingestion/ingestion-worker.ts's
// instagram-lane block for the full reasoning.

import {
  assertHostResolvesToPublicAddress,
  assertRequestUrlAllowed,
  assertRedirectUrlAllowed,
} from './host-policy.js';
import { sha256Hex } from '../core/hash.js';
import { DEFAULT_USER_AGENT } from '../core/config.js';
import type { DnsLookupFn, CrawlTarget } from '../core/types.js';

/** A cheap "has this page changed" fingerprint. Cheaper than a full crawl by
 *  orders of magnitude: a HEAD/ranged GET and a hash, no parsing, no LLM. */
export type CheapChangeSignal = {
  etag: string | null;
  lastModified: string | null;
  bodyHash: string | null;
};

/** Signals keyed by URL — a target has one per page it tracks. */
export type CheapChangeSignalStore = Record<string, CheapChangeSignal>;


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
    safeUrl = assertRequestUrlAllowed(source, url);
    // Static string checks alone don't catch DNS rebinding (a hostname
    // that reads as public but resolves to a private address) — the same
    // resolution check every other direct-fetch call site in this repo
    // (secure-crawlee-runner.ts, secure-browser-runner.ts) applies before
    // fetching.
    await assertHostResolvesToPublicAddress(safeUrl.hostname, opts?.dnsLookup);
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    // Follow redirects MANUALLY, re-validating each hop (same-site https +
    // DNS SSRF) — `follow` would fetch every intermediate hop before any host
    // on the chain is validated. Bailing on a redirect (the old behavior) made
    // this probe return null for EVERY redirecting source (apex<->www,
    // trailing slash), so it never read their ETag/Last-Modified and the source
    // paid for a full re-crawl every tick even when unchanged.
    let currentUrl = safeUrl.toString();
    let response: Response | null = null;
    for (let hop = 0; hop <= PROBE_MAX_REDIRECTS; hop += 1) {
      response = await fetch(currentUrl, {
        method: 'GET',
        headers: { 'User-Agent': DEFAULT_USER_AGENT },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      if (!location || hop === PROBE_MAX_REDIRECTS) return null;
      let next: URL;
      try {
        next = assertRedirectUrlAllowed(source, new URL(location, currentUrl).toString());
      } catch {
        return null;
      }
      try {
        await assertHostResolvesToPublicAddress(next.hostname);
      } catch {
        return null;
      }
      currentUrl = next.toString();
    }

    if (!response || response.status === 0 || response.status < 200 || response.status >= 300) {
      return null;
    }

    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');

    // Only pay for the body-hash fallback when neither header is present —
    // most static/server-rendered pages send one of these, and reading a
    // capped body is cheap either way.
    let bodyHash: string | null = null;
    if (!etag && !lastModified && response.ok) {
      const text = await response.text().catch(() => '');
      bodyHash = await sha256Hex(text.slice(0, PROBE_MAX_BODY_BYTES));
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
