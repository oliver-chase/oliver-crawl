// ─── Sitemap discovery (free) ───────────────────────────────────────────────
//
// The cheapest possible answer to "what pages does this site have": the site
// tells you. /sitemap.xml is fetched once, parsed with two regexes (a
// sitemap's schema is flat enough that a full XML parser buys nothing), and
// filtered to same-site https URLs. Handles sitemap INDEX files (a sitemap
// of sitemaps) one level deep, which covers every real-world generator
// (WordPress, Squarespace, Wix all emit index → children).
//
// This feeds crawlSite's `seeds` — a consumer that discovers a site's event
// pages from its sitemap crawls exactly the right pages instead of guessing
// paths or burning budget following pagination.
//
// Free, deterministic, no LLM, and guarded by the same host policy as every
// other fetch in this package.

import { assertHostResolvesToPublicAddress, assertRequestUrlAllowed } from './host-policy.js';
import type { CrawlTarget, DnsLookupFn } from '../core/types.js';

const SITEMAP_TIMEOUT_MS = 10_000;
const SITEMAP_MAX_BYTES = 2_000_000;
const MAX_CHILD_SITEMAPS = 5;
const DEFAULT_MAX_URLS = 200;

/** One `<url>` entry from a sitemap. */
export type SitemapEntry = {
  url: string;
  /**
   * The sitemap's `<lastmod>`, verbatim, or null when absent.
   *
   * BETTER-LASTMOD-1: origin-supplied and frequently a lie — plenty of CMSs
   * stamp every URL with today's date. Safe to use only to SKIP work (this
   * value equals the stored one, so don't bother re-fetching); never to
   * assert a page DID change.
   */
  lastmod: string | null;
};

export type SitemapDiscoveryResult = {
  /** Same-site page URLs the sitemap lists, capped at maxUrls. */
  urls: string[];
  /** The same URLs with their `<lastmod>`, for cheap re-crawl skipping. */
  entries: SitemapEntry[];
  /** True when the sitemap listed more than maxUrls — the caller is seeing a
   *  prefix, not the whole site. */
  truncated: boolean;
  /** Why urls is empty, when it is. */
  reason: string;
};

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // &amp; last, so &amp;lt; decodes to &lt; and not to <
    .replace(/&amp;/g, '&');
}

/**
 * Extract `<url>` entries with their `<lastmod>`.
 *
 * BETTER-LASTMOD-1: a sitemap answers "which of these 500 pages changed" in
 * ONE request. Conditional GET answers the same question in 500 requests, one
 * per page. We were fetching the sitemap already and discarding the field.
 *
 * Falls back to a bare `<loc>` scan for entries that do not sit inside a
 * `<url>` wrapper, so a malformed sitemap still yields its URLs.
 */
function extractEntries(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  const seen = new Set<string>();

  const urlBlock = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
  let block: RegExpExecArray | null;
  while ((block = urlBlock.exec(xml)) !== null) {
    const inner = block[1] ?? '';
    const loc = /<loc>\s*([^<]+?)\s*<\/loc>/i.exec(inner);
    if (!loc?.[1]) continue;
    const url = decodeXmlEntities(loc[1]);
    if (seen.has(url)) continue;
    seen.add(url);
    const mod = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i.exec(inner);
    entries.push({ url, lastmod: mod?.[1] ? decodeXmlEntities(mod[1]).trim() : null });
  }

  // Sitemaps that list <loc> outside a <url> wrapper (and sitemap indexes,
  // whose children sit in <sitemap> blocks) still need their URLs read.
  for (const loc of extractLocs(xml)) {
    if (!seen.has(loc)) {
      seen.add(loc);
      entries.push({ url: loc, lastmod: null });
    }
  }

  return entries;
}

/** Extract <loc> values from sitemap XML. Entity-decodes the handful XML
 *  actually requires. */
function extractLocs(xml: string): string[] {
  const locs: string[] = [];
  const pattern = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const raw = decodeXmlEntities(match[1] ?? '');
    if (raw) locs.push(raw);
  }
  return locs;
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

async function fetchXml(url: string, userAgent: string, timeoutMs: number): Promise<string | null> {
  const response = await fetch(url, {
    headers: { 'user-agent': userAgent, accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  if (!response.ok) return null;
  const text = await response.text();
  return text.length > SITEMAP_MAX_BYTES ? text.slice(0, SITEMAP_MAX_BYTES) : text;
}

/**
 * Discover a target's pages from its sitemap. Returns an empty list (with a
 * reason) rather than throwing — no sitemap is a normal condition, not an
 * error.
 */
export async function discoverSitemapUrls(
  target: CrawlTarget,
  options: { userAgent: string; maxUrls?: number; dnsLookup?: DnsLookupFn },
): Promise<SitemapDiscoveryResult> {
  const maxUrls = Math.max(1, options.maxUrls ?? DEFAULT_MAX_URLS);

  let sitemapUrl: URL;
  try {
    const base = new URL(target.baseUrl);
    sitemapUrl = new URL('/sitemap.xml', base.origin);
    await assertHostResolvesToPublicAddress(sitemapUrl.hostname, options.dnsLookup);
  } catch (error) {
    return { urls: [], entries: [], truncated: false, reason: error instanceof Error ? error.message : String(error) };
  }

  let xml: string | null;
  try {
    xml = await fetchXml(sitemapUrl.toString(), options.userAgent, SITEMAP_TIMEOUT_MS);
  } catch (error) {
    return { urls: [], entries: [], truncated: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!xml) return { urls: [], entries: [], truncated: false, reason: 'No sitemap.xml (or it did not answer 200).' };

  // A sitemap INDEX lists child sitemaps, not pages — follow same-site
  // children (bounded) and collect their pages instead.
  let pageEntries: SitemapEntry[] = [];
  if (isSitemapIndex(xml)) {
    const children = extractLocs(xml).slice(0, MAX_CHILD_SITEMAPS);
    for (const child of children) {
      try {
        // Same-site enforcement on the child sitemap URL itself — an index
        // pointing at another host's sitemap is not ours to fetch.
        const safe = assertRequestUrlAllowed(target, child);
        const childXml = await fetchXml(safe.toString(), options.userAgent, SITEMAP_TIMEOUT_MS);
        if (childXml && !isSitemapIndex(childXml)) pageEntries.push(...extractEntries(childXml));
      } catch {
        // one bad child sitemap doesn't spoil the rest
      }
      if (pageEntries.length >= maxUrls + 1) break;
    }
  } else {
    pageEntries = extractEntries(xml);
  }

  // Same-site filter on every page URL: a sitemap is origin-controlled
  // content and gets no more trust than a page's own links.
  const entries: SitemapEntry[] = [];
  const seen = new Set<string>();
  for (const entry of pageEntries) {
    if (entries.length >= maxUrls) break;
    try {
      const safe = assertRequestUrlAllowed(target, entry.url).toString();
      if (!seen.has(safe)) {
        seen.add(safe);
        entries.push({ url: safe, lastmod: entry.lastmod });
      }
    } catch {
      // off-site or unsafe entry — skip, not an error
    }
  }
  const urls = entries.map((e) => e.url);

  return {
    urls,
    entries,
    truncated: pageEntries.length > urls.length && urls.length === maxUrls,
    reason: urls.length === 0 ? 'Sitemap present but contained no same-site https URLs.' : '',
  };
}
