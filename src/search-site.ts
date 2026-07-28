// ─── Search a site using the site's own search ──────────────────────────────
//
// SEARCH-ONSITE-1 (2026-07-27). `crawler.search()` asks a search engine, which
// always costs money and returns the whole web. But the question consumers
// actually ask most often is narrower — "which pages on THIS site are about
// X" — and nearly every site already answers it.
//
// Most platforms expose search over a plain query string: WordPress `/?s=`,
// Shopify and Squarespace `/search?q=`, and a large tail of custom sites on
// `/search?q=` or `/search/?query=`. Submitting a query to a site's own search
// form is ordinary use of a published feature, not scraping around one, so
// this is free and uncontroversial in a way SERP scraping is not.
//
// It also reaches pages the crawler otherwise cannot. Link-following finds
// what a site links; a sitemap finds what it publishes. Neither finds an
// archived page reachable only through search, and on a large site those are
// often the ones a consumer wants.
//
// What this is NOT: a replacement for web search. It cannot tell you which
// sites exist. Use it once you know the site and want its relevant pages.

import type { Crawler } from './index.js';
import type { CrawlTarget } from './core/types.js';
import { urlDedupKey } from './core/url-dedup-key.js';

/** Query-string shapes, in the order they are tried. */
const SEARCH_PATTERNS: ReadonlyArray<{ platform: string; build: (base: string, q: string) => string }> = [
  { platform: 'wordpress', build: (b, q) => `${b}/?s=${q}` },
  { platform: 'generic', build: (b, q) => `${b}/search?q=${q}` },
  { platform: 'squarespace', build: (b, q) => `${b}/search?q=${q}&f_collectionId=` },
  { platform: 'drupal-ish', build: (b, q) => `${b}/search/node?keys=${q}` },
  { platform: 'query-param', build: (b, q) => `${b}/search/?query=${q}` },
];

export type SiteSearchResult = {
  ok: boolean;
  /** Same-site URLs the site's own search returned, deduped. */
  urls: string[];
  /** Which pattern produced them, for a consumer that wants to cache it. */
  pattern: string | null;
  /** Why nothing came back, when nothing did. */
  detail: string;
};

export type SiteSearchOptions = {
  /** Cap on returned URLs. Default 25. */
  maxResults?: number;
  /**
   * A pattern known to work for this site, from a previous call's `pattern`.
   * Skips probing, which is the expensive part — each probe is a real request.
   */
  knownPattern?: string;
};

/**
 * Links that are navigation rather than results.
 *
 * A search results page carries the site's whole nav, and returning "Home",
 * "Contact" and a login link as search hits would be worse than returning
 * nothing — a consumer would crawl them believing they matched.
 */
const NAV_LINK = /^(home|about|contact|menu|login|log in|sign in|search|cart|account|privacy|terms|back|next|previous|â€¹|â€º|\d+)$/i;

/**
 * Paths that are assets rather than pages. A results page links the images
 * inside each result, and a live run returned `/wp-content/uploads/*.png` as
 * hits — a consumer would then "crawl" a screenshot.
 */
const ASSET_PATH = /(\/wp-content\/uploads\/|\/wp-includes\/|\/assets?\/|\/static\/)/i;
const ASSET_EXTENSION = /\.(png|jpe?g|gif|webp|svg|ico|css|js|zip|mp4|mp3|woff2?)$/i;

function looksLikeResultLink(text: string, url: string, baseUrl: string): boolean {
  const label = text.trim();
  if (!label || NAV_LINK.test(label)) return false;
  // A result title is a phrase; a nav item is a word or two.
  if (label.length < 8) return false;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== new URL(baseUrl).origin) return false;
    const path = parsed.pathname;
    // The search page linking to itself is not a result.
    if (/\/search\b/i.test(path) || path === '/' || path === '') return false;
    if (ASSET_PATH.test(path) || ASSET_EXTENSION.test(path)) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Result links are read from the MAIN CONTENT region, via markdown, not from
 * `page.links`.
 *
 * `page.links` is every link on the page including the site's whole
 * navigation, and a results page carries the same nav as any other. Using it
 * returned "Membership" and "Plan your visit" as hits for "summer camp" —
 * worse than returning nothing, because a consumer would crawl them believing
 * they matched. The markdown is already chrome-stripped, so its links are the
 * results.
 */
const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

function resultLinksFromMarkdown(markdown: string, baseUrl: string): Array<{ text: string; url: string }> {
  const out: Array<{ text: string; url: string }> = [];
  for (const match of markdown.matchAll(MARKDOWN_LINK)) {
    const text = match[1] ?? '';
    const href = match[2] ?? '';
    let absolute: string;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (looksLikeResultLink(text, absolute, baseUrl)) out.push({ text, url: absolute });
  }
  return out;
}

/**
 * Search a site using its own search feature.
 *
 * ```ts
 * const found = await searchSite(crawler, target, 'annual report');
 * const run = await crawlSite(crawler, target, { seeds: found.urls });
 * ```
 *
 * Returns `ok: false` rather than throwing when the site has no usable search
 * — plenty do not, and that is an ordinary answer rather than an error.
 */
export async function searchSite(
  crawler: Crawler,
  target: CrawlTarget,
  query: string,
  options: SiteSearchOptions = {},
): Promise<SiteSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) return { ok: false, urls: [], pattern: null, detail: 'Empty query.' };

  const maxResults = Math.max(1, options.maxResults ?? 25);
  const base = target.baseUrl.replace(/\/+$/, '');
  const encoded = encodeURIComponent(trimmed);

  const patterns = options.knownPattern
    ? SEARCH_PATTERNS.filter((p) => p.platform === options.knownPattern)
    : SEARCH_PATTERNS;

  let lastDetail = 'No search pattern returned results.';

  for (const pattern of patterns) {
    const searchUrl = pattern.build(base, encoded);

    // Through the crawler, so robots, SSRF screening, throttling and the
    // injection guard all apply — a search results page is page content like
    // any other, and the site's own search is not a reason to skip any of it.
    const result = await crawler.crawl(target, searchUrl);

    if (!result.ok) {
      lastDetail = `${pattern.platform}: ${result.detail}`;
      // A policy refusal will not change across patterns — stop asking.
      if (result.reason === 'blocked' || result.reason === 'quarantined') break;
      continue;
    }
    if (result.notModified) continue;

    const page = result.pages[0];
    if (!page) continue;

    const seen = new Set<string>();
    const urls: string[] = [];
    for (const link of resultLinksFromMarkdown(page.markdown, base)) {
      const key = urlDedupKey(link.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      urls.push(link.url);
      if (urls.length >= maxResults) break;
    }

    // A site with no match for this query still renders a results page, so a
    // thin result set means "no matches", not "wrong pattern". Only an
    // outright empty one is worth trying the next pattern for.
    if (urls.length > 0) {
      return { ok: true, urls, pattern: pattern.platform, detail: '' };
    }
    lastDetail = `${pattern.platform}: results page had no result-shaped links`;
  }

  return { ok: false, urls: [], pattern: null, detail: lastDetail };
}
