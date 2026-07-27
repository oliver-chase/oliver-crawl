// ─── Feed discovery: route around a scrape by finding a structured feed ─────
//
// Owner directive: a site blocking the HTML/render crawl is not a reason to
// drop the source — find a way to get accurate, repeatable data. Most venue
// platforms (The Events Calendar / WordPress, Squarespace, Wix, Eventbrite,
// etc.) publish an ICS calendar feed that is MORE accurate and more stable
// than scraping rendered HTML: the feed's own fields ARE the structured data,
// no LLM extraction, no JS render, no Cloudflare wall on the page route.
//
// This probes a source's site for such a feed and validates it really is one
// (fetches it, checks for BEGIN:VCALENDAR) before handing it back. The admin
// "Find a feed" action then switches the source to the ics lane with the
// discovered URL. Fail-closed: returns { feedUrl: null } on anything it can't
// positively confirm — never a guessed URL that wasn't fetched and validated.

import { assertHostResolvesToPublicAddress } from './host-policy.js';
import { DEFAULT_USER_AGENT } from '../core/config.js';

export type FeedDiscoveryResult = { feedUrl: string | null; reason: string };

const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 1_000_000;
const MAX_FEED_BYTES = 2_000_000;
const MAX_REDIRECTS = 4;

// SSRF-guarded fetch that follows redirects manually, re-validating each hop's
// host — same discipline as robots-check / cheap-change-probe. Exported so the
// source auto-router (source-autofix.ts) reuses the exact same guard.
export async function safeFetch(rawUrl: string, doFetch: typeof fetch, accept: string): Promise<Response | null> {
  let current: URL;
  try {
    current = new URL(rawUrl);
    if (current.protocol !== 'https:' && current.protocol !== 'http:') return null;
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      try {
        await assertHostResolvesToPublicAddress(current.hostname);
      } catch {
        return null;
      }
      const res = await doFetch(current.toString(), {
        method: 'GET',
        headers: { 'User-Agent': DEFAULT_USER_AGENT, accept },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (res.status < 300 || res.status >= 400) return res;
      const location = res.headers.get('location');
      if (!location || hop === MAX_REDIRECTS) return null;
      try {
        current = new URL(location, current);
      } catch {
        return null;
      }
      if (current.protocol !== 'https:' && current.protocol !== 'http:') return null;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Pull <link rel="alternate" type="text/calendar" href> (and rel=alternate
// hrefs ending .ics) out of a page's HTML head. Exported for tests.
export function parseFeedLinksFromHtml(html: string, pageUrl: string): string[] {
  const found: string[] = [];
  const linkTag = /<link\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkTag.exec(html)) !== null) {
    const tag = match[0];
    if (!/rel\s*=\s*["']?[^"'>]*alternate/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    const isCalType = /type\s*=\s*["'][^"']*text\/calendar[^"']*["']/i.test(tag);
    const isIcsHref = /\.ics(\?|#|$)/i.test(href);
    if (!isCalType && !isIcsHref) continue;
    try {
      found.push(new URL(href, pageUrl).toString());
    } catch {
      // skip unresolvable href
    }
  }
  return Array.from(new Set(found));
}

// DETERMINISM-1b: Google Calendar embeds. A page embedding
// calendar.google.com/calendar/embed?src=<id> (the standard widget on
// rec-district/municipal sites) exposes each embedded calendar's PUBLIC ICS
// feed at a derivable URL — deterministic, zero LLM, and it converts the
// "calendar widget" class (unreadable to a plain scrape) into the free ICS
// lane. Every derived candidate is still fetch-validated before use.
// Exported for tests.
export function googleCalendarIcsCandidates(html: string): string[] {
  const out = new Set<string>();
  const embed = /calendar\.google\.com\/calendar\/(?:u\/\d+\/)?embed\?([^"'<>\s]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = embed.exec(html)) !== null) {
    const query = (match[1] ?? '').replace(/&amp;/g, '&');
    try {
      const params = new URLSearchParams(query);
      for (const src of params.getAll('src')) {
        if (src) out.add(`https://calendar.google.com/calendar/ical/${encodeURIComponent(src)}/public/basic.ics`);
      }
    } catch {
      // skip an unparseable embed query
    }
  }
  // Direct public-ICS links some sites paste as-is.
  const direct = /https:\/\/calendar\.google\.com\/calendar\/ical\/[^"'<>\s]+\/public\/basic\.ics/gi;
  while ((match = direct.exec(html)) !== null) {
    out.add(match[0].replace(/&amp;/g, '&'));
  }
  return Array.from(out);
}

// Common platform ICS URL patterns to try when the page declares no feed link.
// Each is a guess; every candidate is fetched + validated before use.
export function candidateIcsUrls(pageUrl: string): string[] {
  const out = new Set<string>();
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return [];
  }
  const withParam = (base: string, key: string, value: string): void => {
    try {
      const c = new URL(base);
      c.searchParams.set(key, value);
      out.add(c.toString());
    } catch {
      // skip unbuildable candidate
    }
  };
  // The Events Calendar (WordPress) — the most common venue plugin — exposes
  // ?ical=1 on the events page path and on the conventional /events, /calendar.
  withParam(pageUrl, 'ical', '1');
  withParam(`${origin}/events`, 'ical', '1');
  withParam(`${origin}/calendar`, 'ical', '1');
  // Squarespace event collections: ?format=ical.
  withParam(pageUrl, 'format', 'ical');
  // Bare conventional feed paths.
  out.add(`${origin}/events.ics`);
  out.add(`${origin}/calendar.ics`);
  out.add(`${origin}/?post_type=tribe_events&ical=1`);
  return Array.from(out);
}

function looksLikeIcs(body: string): boolean {
  return /BEGIN:VCALENDAR/i.test(body.slice(0, 4_000));
}

async function validateIcsUrl(url: string, doFetch: typeof fetch): Promise<boolean> {
  const res = await safeFetch(url, doFetch, 'text/calendar,text/plain');
  if (!res || !res.ok) return false;
  const contentType = res.headers.get('content-type') || '';
  const body = (await res.text().catch(() => '')).slice(0, MAX_FEED_BYTES);
  // Trust content-type OR the actual VCALENDAR marker — some servers mislabel
  // ICS as text/plain or octet-stream, so the body check is the real gate.
  if (!looksLikeIcs(body)) return false;
  void contentType;
  return true;
}

// Probe a source's site for a validated ICS feed. Order: feed links declared
// in the page HTML first (authoritative), then common platform guesses.
export async function discoverIcsFeed(
  baseUrl: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<FeedDiscoveryResult> {
  const doFetch = opts?.fetchImpl ?? fetch;

  // If baseUrl is already an ICS feed, nothing to discover.
  const pageRes = await safeFetch(baseUrl, doFetch, 'text/html,application/xhtml+xml,text/calendar');
  if (pageRes && pageRes.ok) {
    const contentType = pageRes.headers.get('content-type') || '';
    const body = (await pageRes.text().catch(() => '')).slice(0, MAX_HTML_BYTES);
    if (/text\/calendar/i.test(contentType) || looksLikeIcs(body)) {
      return { feedUrl: baseUrl, reason: 'the source URL is already an ICS feed' };
    }
    const declared = parseFeedLinksFromHtml(body, baseUrl);
    for (const candidate of declared) {
      if (await validateIcsUrl(candidate, doFetch)) {
        return { feedUrl: candidate, reason: 'found an ICS feed declared in the page (rel="alternate")' };
      }
    }
    // DETERMINISM-1b: Google Calendar embed -> derived public ICS.
    for (const candidate of googleCalendarIcsCandidates(body)) {
      if (await validateIcsUrl(candidate, doFetch)) {
        return { feedUrl: candidate, reason: 'derived from a Google Calendar embed on the page' };
      }
    }
  }

  for (const candidate of candidateIcsUrls(baseUrl)) {
    if (await validateIcsUrl(candidate, doFetch)) {
      return { feedUrl: candidate, reason: 'found an ICS feed at a common platform path' };
    }
  }

  return { feedUrl: null, reason: 'no ICS feed found — this source needs the browser lane or a manual feed URL' };
}
