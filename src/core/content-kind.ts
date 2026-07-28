// ─── What kind of document did we just fetch? ───────────────────────────────
//
// CRAWL-FEED-1: the own lane accepted only html/xhtml/plain and
// refused everything else as `empty`. That made a documented capability
// unusable: fetch/feed-discovery.ts exists to FIND ICS calendar feeds — and
// argues in its own header that they are more accurate and more stable than
// scraping the page — while the fetch rung could not then read one.
//
// Widening the accepted set is a BODY-HANDLING change only. Nothing here
// touches what URLs we are willing to request: SSRF, same-site, robots and
// the injection guard are unchanged and still run first.

import type { ContentKind } from './types.js';

/**
 * Classify a Content-Type header.
 *
 * Returns null for anything we will not read — images, video, binaries.
 * Refusing those is correct: HTML-parsing a JPEG produces confident nonsense.
 *
 * Matched before the `;charset=` parameter, and order matters: the XML feed
 * types are checked ahead of bare `application/xml` so an Atom feed is not
 * demoted to generic text.
 */
export function classifyContentType(contentType: string): ContentKind | null {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (!type) return null;

  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type === 'text/calendar') return 'calendar';
  if (type === 'text/csv') return 'csv';
  if (type === 'application/json' || type.endsWith('+json')) return 'json';
  if (type === 'application/rss+xml' || type === 'application/atom+xml') return 'feed';
  // A feed served as generic XML is extremely common; treat XML as a feed
  // rather than refusing it, since the caller parses it either way.
  if (type === 'application/xml' || type === 'text/xml') return 'feed';
  if (type === 'text/plain') return 'text';
  // CRAWL-PDF-1: read only when the optional parser is installed; the rung
  // reports a clear structural failure naming the package otherwise.
  if (type === 'application/pdf') return 'pdf';

  return null;
}

/**
 * Some servers send ICS and CSV as `text/plain` or `application/octet-stream`.
 * When the URL itself is unambiguous, trust it over a lazy header — but only
 * to REFINE a type we already agreed to read, never to accept one we refused.
 * That keeps the extension from being a way around the content-type gate.
 */
export function refineKindByUrl(kind: ContentKind, url: string): ContentKind {
  if (kind !== 'text') return kind;
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return kind;
  }
  if (path.endsWith('.ics')) return 'calendar';
  if (path.endsWith('.csv')) return 'csv';
  return kind;
}
