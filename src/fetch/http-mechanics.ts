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

export async function fetchFollowingSafeRedirects(
  url: URL,
  config: ResolvedConfig,
  timeoutMs: number,
  validators: { etag?: string | null; lastModified?: string | null } = {},
  extraHeaders: Record<string, string> = {},
  maxHops = 5,
): Promise<Response> {
  let current = url;
  const baseHost = url.hostname;
  const basePort = url.port || '';

  // CRAWL-VALIDATE-1 (found in self-audit): the FIRST version of
  // this accepted etag/lastModified in CrawlOptions, documented the free-304
  // path in the lane header, had the 304 branch in the caller — and never
  // sent If-None-Match / If-Modified-Since on the wire. The 304 test passed
  // only because its stub returned 304 unconditionally, so the whole
  // "cheapest crawl is the one that doesn't happen" story was dead code
  // against a real origin. Headers are sent on every hop: harmless on a
  // redirect (redirects don't 304), correct on the final resource.
  const conditionalHeaders: Record<string, string> = {};
  if (validators.etag) conditionalHeaders['if-none-match'] = validators.etag;
  if (validators.lastModified) conditionalHeaders['if-modified-since'] = validators.lastModified;

  for (let hop = 0; hop <= maxHops; hop++) {
    const response = await fetch(current, {
      redirect: 'manual',
      headers: {
        'user-agent': config.userAgent,
        // PARITY-HEADERS-1: a plausible, internally-consistent header set.
        // A missing accept-language is one of the oldest bot tells there is —
        // every real browser sends one — and naive WAF rules key on exactly
        // that. Raising the direct-fetch rung's pass rate is what keeps
        // crawls off the render rung; free is only free while the cheap rung
        // usually wins.
        //
        // Deliberately NOT sent: sec-ch-ua and friends. Those claim "I am
        // Chrome N on platform X", which is a lie next to an honest bot UA —
        // and a *half*-consistent browser disguise is a stronger tell than no
        // disguise. We claim only things true of any polite HTTP client.
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
        'accept-language': 'en-US,en;q=0.9',
        // accept-encoding stays runtime-owned (see RESERVED_HEADERS): the
        // runtime only auto-decompresses encodings IT negotiated, and
        // claiming one it can't handle would corrupt every body silently.
        // Caller-supplied credentials for this target. Safe to keep across
        // hops because every hop is re-validated same-site (a redirect off
        // this host throws before we would send anything).
        ...extraHeaders,
        ...conditionalHeaders,
      },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });

    if (response.status < 300 || response.status > 399) return response;

    const location = response.headers.get('location');
    if (!location) return response;

    const next = new URL(location, current);
    // Throws on off-domain/downgrade/private — the caller turns that into a
    // blocked/unreachable result rather than silently following.
    assertRedirectUrlAllowedForHost(baseHost, basePort, next.toString());
    await assertHostResolvesToPublicAddress(next.hostname, config.dnsLookup);
    current = next;
  }

  throw new Error(`Too many redirects (>${maxHops}) starting at ${url.toString()}`);
}
