// ─── Listing pagination following ────────────────────────────────
//
// A paginated calendar/listing page ("page 1 of 4", "Older events ›") only
// ever gets its FIRST page crawled today — everything past it is invisible.
// On a source's first-ever crawl, follow the seed page's own "next page"
// link up to a small cap, adding each followed page as an extra seed
// alongside F1's sitemap URLs. Unlike F1 (all seeds discoverable from one
// sitemap fetch upfront), pagination is inherently sequential — page 3's URL
// only exists in page 2's HTML — so this walks one page at a time.
//
// Known scope limit (not a bug): this walks the RAW HTML, a plain fetch —
// deliberately free/deterministic regardless of the source's own crawl lane,
// same reasoning F1's sitemap fetch already has. A browser-lane source whose
// "next page" link only exists in the client-rendered DOM (not the raw HTML)
// simply won't be found here; it fails soft to zero followed pages, same as
// a source with no pagination at all, not an error. Paying for a render just
// to DISCOVER a link (before the main crawl even runs) isn't a good trade.

import { pooledFetchFor } from '../fetch/connection-pool.js';
import { safeFetch } from '../fetch/safe-fetch.js';
import { readBodyCapped } from '../fetch/http-mechanics.js';
import { hostsMatchAllowingWww } from '../fetch/host-policy.js';
import type { DnsLookupFn } from '../core/types.js';

// "Capped 3 pages" (spec) = the seed page + 2 followed pages.
const MAX_ADDITIONAL_PAGES = 2;
const MAX_HTML_BYTES = 1_500_000;

// Conservative on purpose: an exact (trimmed, case-insensitive) label match,
// not "label contains next" — a substring match would false-positive on a
// real event titled "Next Level Comedy Night" or "The Next Chapter Tour".
// rel="next" (checked first, below) is the unambiguous signal; this list is
// the narrow fallback for sites that only use link text.
const NEXT_PAGE_LABELS = new Set([
  'next', 'next »', 'next ›', 'next >', 'next page', '»', '›', '>>',
  'older', 'older events', 'older posts',
  'more events', 'view more events', 'view more', 'load more', 'load more events',
  'see more events', 'more', 'show more',
]);

/** rel="next" on an `<a>` (or a `<link rel="next">` in the head) is the
 *  unambiguous HTML pagination signal (WHATWG-documented convention) —
 *  checked before any text-label heuristic. */
function findRelNextHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const anchorPattern = /<(?:a|link)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    const tag = match[0];
    // Whitespace before "rel" keeps out data-rel="next", which carousel
    // plugins use for the next slide, since a hyphen is a word boundary.
    if (!/\srel\s*=\s*["']?[^"'>]*\bnext\b/i.test(tag)) continue;
    const hrefMatch = tag.match(/\shref\s*=\s*(?:["']([^"'#][^"']*)["']|([^\s"'>#][^\s>]*))/i);
    const href = hrefMatch?.[1] ?? hrefMatch?.[2];
    if (href) hrefs.push(href);
  }
  return hrefs;
}

/** Fallback: an `<a>` whose LABEL text exactly matches a known pagination
 *  phrase (see NEXT_PAGE_LABELS above). */
function findLabelMatchHref(html: string): string | null {
  const anchorPattern = /<a\b[^>]*\shref\s*=\s*(?:["']([^"'#][^"']*)["']|([^\s"'>#][^\s>]*))[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    const href = (match[1] ?? match[2] ?? '').trim();
    const label = (match[3] ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (href && NEXT_PAGE_LABELS.has(label)) return href;
  }
  return null;
}

/** Finds this page's "next page" URL, or null when there isn't one. Exported
 *  for direct testing. */
export function findNextPageUrl(html: string, pageUrl: string): string | null {
  const labelHref = findLabelMatchHref(html);
  const candidates = [...findRelNextHrefs(html), ...(labelHref ? [labelHref] : [])];
  for (const href of candidates) {
    try {
      const resolved = new URL(href, pageUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') return resolved.toString();
    } catch {
      // an unusable candidate: try the next one
    }
  }
  return null;
}

/**
 * Walks a seed page's "next page" link up to MAX_ADDITIONAL_PAGES hops,
 * returning the followed page URLs (page 2, page 3 — NOT the seed page
 * itself, which is already crawled separately). Stops on: no next link, a
 * fetch failure, or a link that loops back to an already-visited page (a
 * same-site nav quirk, not real pagination). Fail-soft: never throws — a
 * broken/absent pagination link just means the seed page crawls alone, as
 * it does today.
 */
export async function discoverPaginatedUrls(
  seedUrl: string,
  opts?: { fetchImpl?: typeof fetch; userAgent?: string; dnsLookup?: DnsLookupFn },
): Promise<string[]> {
  const doFetch = opts?.fetchImpl ?? pooledFetchFor(opts?.dnsLookup);
  const visited = new Set<string>([seedUrl]);
  const discovered: string[] = [];
  let currentUrl = seedUrl;

  try {
    for (let hop = 0; hop < MAX_ADDITIONAL_PAGES; hop++) {
      const res = await safeFetch(currentUrl, doFetch, 'text/html,application/xhtml+xml', {
        sameSiteAs: seedUrl,
        ...(opts?.userAgent ? { userAgent: opts.userAgent } : {}),
        ...(opts?.dnsLookup ? { dnsLookup: opts.dnsLookup } : {}),
      });
      if (!res || !res.ok) break;
      const html = await readBodyCapped(res, MAX_HTML_BYTES).catch(() => '');
      const nextUrl = findNextPageUrl(html, currentUrl);
      // A next link is page content, so it may not lead off the seed's site.
      if (!nextUrl || visited.has(nextUrl) || !hostsMatchAllowingWww(new URL(nextUrl).hostname, new URL(seedUrl).hostname)) break;
      visited.add(nextUrl);
      discovered.push(nextUrl);
      currentUrl = nextUrl;
    }
  } catch {
    return discovered; // whatever was found before the failure is still valid
  }

  return discovered;
}
