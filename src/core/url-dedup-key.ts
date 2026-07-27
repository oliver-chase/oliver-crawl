// ─── Canonical dedup key for a URL ──────────────────────────────────────────
//
// URL-DEDUP-1 (2026-07-27, found auditing this package against Fallow, which
// had already hit it): one page is routinely reachable under several
// spellings. A site's own nav will link its calendar as `/events`, its footer
// as `/events/`, a "see the lineup" button as `/events#lineup`, and its
// Facebook share link as `/events?utm_source=facebook`.
//
// Keying dedup on the raw URL string sees four pages there. The crawler then
// fetches the same document four times, returns it four times, and spends
// four slots of `maxPages` doing it — on a site crawled with maxPages: 20,
// that is a fifth of the budget burned to learn nothing, while real pages go
// unvisited because the queue ran out.
//
// ── This key is for IDENTITY ONLY, never for fetching ──
//
// The crawler still requests the exact URL the site published. Normalising
// what we REQUEST would be a different and worse bug: some servers really do
// treat `/events` and `/events/` as different resources, and some care about
// param order. We only ever use this to answer "have I already seen this?"
//
// ── Why this is more conservative than Fallow's version ──
//
// Fallow's `url-normalize.ts` also strips `ref`, `ref_src` and `source`. That
// is right for de-duplicating URLs a human pasted into a submission box, where
// the cost of a wrong merge is one re-paste.
//
// It is wrong for a crawler. Some CMSs genuinely route on `?source=` or
// `?ref=`, so merging those would silently drop a real page — and a page never
// fetched is a page whose absence nobody can see. The two failure modes are
// not symmetric:
//
//   missed merge  -> a duplicate fetch. Wasteful, visible, harmless.
//   wrong merge   -> a real page is never crawled. Invisible, and the data
//                    is simply gone.
//
// So this strips only parameters that are unambiguously analytics tracking —
// ones with no routing meaning on any server. When in doubt, keep the param
// and eat the duplicate fetch.

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
