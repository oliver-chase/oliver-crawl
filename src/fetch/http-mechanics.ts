// ─── HTTP mechanics for the direct-fetch rung ───────────────────────────────
//
// Reading a response safely, and following redirects without trusting any hop
// before it has been validated. Separated from the own lane so that file
// carries policy and the rung ladder rather than transport detail.
//
// Everything here is a guard as much as a convenience: the body cap bounds
// memory against a hostile origin, the manual redirect loop re-validates each
// hop before a request is made to it, and the Retry-After parser exists so an
// origin's own instruction beats our guess.

import { decodeBody } from '../core/charset.js';
import { assertRedirectUrlAllowedForHost, assertHostResolvesToPublicAddress } from './host-policy.js';
import type { ResolvedConfig } from '../core/config.js';
import { pooledFetch } from './connection-pool.js';

/**
 * Parse a Retry-After header, which the spec allows in two forms: delay in
 * seconds, or an HTTP date. Returns ms, capped at 5 minutes — an origin
 * asking for an hour should not hang a crawl run that long.
 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 300_000);
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) return Math.min(Math.max(0, asDate - Date.now()), 300_000);
  return undefined;
}

/**
 * CRAWL-HARDEN-1: read a response body up to `maxBytes`, truncating rather than
 * failing beyond it — the readable prefix of a huge page is still worth
 * extracting from. The cap itself is the point: `response.text()` reads
 * EVERYTHING before returning, so an endless body from a hostile or
 * misconfigured origin ties up memory until the process dies. The sanitiser's
 * char cap protects the LLM; this protects the crawler.
 */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const contentType = response.headers.get('content-type');
  const reader = response.body?.getReader();
  if (!reader) {
    // Runtime without streaming bodies — fall back, but refuse an announced
    // oversize rather than buffering it.
    const announced = Number(response.headers.get('content-length') || 0);
    if (announced > maxBytes) throw new Error(`Response too large: content-length ${announced} > ${maxBytes}`);
    const buffer = new Uint8Array(await response.arrayBuffer());
    return decodeBody(buffer, contentType);
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  const merged = new Uint8Array(Math.min(received, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const room = merged.byteLength - offset;
    if (room <= 0) break;
    merged.set(room >= chunk.byteLength ? chunk : chunk.subarray(0, room), offset);
    offset += Math.min(chunk.byteLength, room);
  }
  // Decode with the origin's declared charset, not a UTF-8 assumption —
  // see core/charset.ts for why that assumption corrupts data silently.
  return decodeBody(merged, contentType);
}

export type RedirectWalk = {
  response: Response;
  finalUrl: URL;
  /** Set when the walk ended on a redirect it did not follow. */
  stopped?: 'no-location' | 'max-hops';
};

/**
 * Follows redirects by hand, one hop at a time. `onRedirect` receives each Location value and the
 * URL it came from, and returns the URL to request next or throws to refuse the hop, so the caller
 * validates every destination before a request is made to it. The single redirect loop in this
 * package: robots, the change probe, feed discovery and the direct fetch all walk through it.
 */
export async function followManualRedirects(
  start: URL,
  options: {
    doFetch: typeof fetch;
    init: () => RequestInit;
    maxHops: number;
    onRedirect: (location: string, current: URL) => Promise<URL> | URL;
  },
): Promise<RedirectWalk> {
  let current = start;
  for (let hop = 0; ; hop += 1) {
    const response = await options.doFetch(current.toString(), { ...options.init(), redirect: 'manual' });
    if (response.status < 300 || response.status > 399) return { response, finalUrl: current };
    const location = response.headers.get('location');
    if (!location) return { response, finalUrl: current, stopped: 'no-location' };
    if (hop >= options.maxHops) return { response, finalUrl: current, stopped: 'max-hops' };
    current = await options.onRedirect(location, current);
  }
}

export async function fetchFollowingSafeRedirects(
  url: URL,
  config: ResolvedConfig,
  timeoutMs: number,
  validators: { etag?: string | null; lastModified?: string | null } = {},
  extraHeaders: Record<string, string> = {},
  maxHops = 5,
  doFetch: typeof fetch = pooledFetch,
): Promise<Response> {
  const baseHost = url.hostname;
  const basePort = url.port || '';

  // CRAWL-VALIDATE-1: the validators go on the wire on every hop, so a real origin can answer 304.
  const conditionalHeaders: Record<string, string> = {};
  if (validators.etag) conditionalHeaders['if-none-match'] = validators.etag;
  if (validators.lastModified) conditionalHeaders['if-modified-since'] = validators.lastModified;

  const walk = await followManualRedirects(url, {
    doFetch,
    maxHops,
    init: () => ({
      headers: {
        'user-agent': config.userAgent,
        // PARITY-HEADERS-1: a plausible, internally consistent header set. A missing accept-language is
        // an old bot tell. sec-ch-ua and similar are not sent, because they claim a browser identity
        // that an honest bot user agent contradicts. accept-encoding stays runtime-owned (see
        // RESERVED_HEADERS), since the runtime only decompresses encodings it negotiated.
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
        'accept-language': 'en-US,en;q=0.9',
        // Caller credentials are safe across hops because every hop is re-validated same-site.
        ...extraHeaders,
        ...conditionalHeaders,
      },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    }),
    onRedirect: async (location, from) => {
      const next = new URL(location, from);
      // Throws on off-domain, downgrade or private; the caller turns that into a blocked result.
      assertRedirectUrlAllowedForHost(baseHost, basePort, next.toString());
      await assertHostResolvesToPublicAddress(next.hostname, config.dnsLookup);
      return next;
    },
  });
  if (walk.stopped === 'max-hops') throw new Error(`Too many redirects (>${maxHops}) starting at ${url.toString()}`);
  return walk.response;
}
