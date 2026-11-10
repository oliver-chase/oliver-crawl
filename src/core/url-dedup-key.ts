// ─── Canonical dedup key for a URL ──────────────────────────────────────────
//
// URL-DEDUP-1: one page is reachable under several spellings — `/events`,
// `/events/`, `/events#lineup`, `/events?utm_source=fb`. Keying dedup on the
// raw string sees four pages and spends four slots of `maxPages` on one.
//
// IDENTITY ONLY, never for fetching: some servers really do treat `/events`
// and `/events/` as different resources, so we still request what the site
// published.
//
// Only unambiguous analytics params are stripped. The failure modes are not
// symmetric — a missed merge costs a duplicate fetch, a wrong merge means a
// real page is never crawled and nobody can see its absence.

/**
 * Parameters that are pure analytics tracking and never affect which document
 * a server returns. Deliberately excludes `ref`, `ref_src` and `source`: those
 * are ambiguous, and a wrong merge loses a page.
 */
const TRACKING_PARAM_RE = /^(utm_[a-z_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|twclid|igshid|mc_cid|mc_eid|_ga|_gl|twscroll|vero_id|s_kwcid)$/i;

/**
 * A canonical identity key for `rawUrl`, for dedup only.
 *
 * Collapses: scheme (http/https of one resource is one resource), host case,
 * a default port, a trailing slash, the fragment, and tracking parameters.
 * Meaningful query parameters are kept — sorted, so that `?a=1&b=2` and
 * `?b=2&a=1` compare equal without either being discarded.
 *
 * Falls back to a lightly-cleaned lowercase string when the URL will not
 * parse, so two identically-malformed links still dedup against each other.
 */
export function urlDedupKey(rawUrl: string): string {
  const input = (rawUrl || '').trim();
  if (!input) return '';

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return input.toLowerCase().replace(/#.*$/, '').replace(/\/+$/, '');
  }

  // `host` keeps a non-default port, which matters — :8080 really is a
  // different service. URL already drops :80/:443 for http/https.
  const host = parsed.host.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, '');

  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM_RE.test(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : '';

  // Scheme is deliberately absent: http://x/a and https://x/a are the same
  // document, and a site that redirects one to the other would otherwise be
  // crawled twice.
  return `${host}${path}${query}`.toLowerCase();
}

/** True when two URLs identify the same resource for dedup purposes. */
export function sameUrlResource(a: string, b: string): boolean {
  const keyA = urlDedupKey(a);
  return Boolean(keyA) && keyA === urlDedupKey(b);
}
