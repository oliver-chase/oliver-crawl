// ─── Is this a block page wearing a 200? ────────────────────────────────────
//
// LADDER-QUALITY-1 (found live on cfdrodeo.com): the local-render
// rung captured Cloudflare's "Why have I been blocked?" interstitial and the
// ladder accepted it, because rung acceptance only asked "did text come back?"
// A 300-character block page therefore beat the Jina rung, which retrieves the
// site's actual content — the crawl reported success while delivering a
// security notice instead of the page.
//
// Detection is deliberately narrow. These phrases appear on challenge and
// block interstitials and essentially nowhere else, and the length bound
// exists because a real article QUOTING a block page is long — the signal is
// a distinctive phrase on a page with nothing else on it.

const BLOCK_PAGE_PATTERNS = [
  /why have i been blocked/i,
  /attention required!?\s*\|\s*cloudflare/i,
  /checking if the site connection is secure/i,
  /verify(?:ing)? you are (?:a )?human/i,
  /enable javascript and cookies to continue/i,
  /just a moment\.{3}/i,
  /access to this page has been denied/i,
  /request unsuccessful\. incapsula incident/i,
  /pardon our interruption/i,
  /you have been rate.?limited/i,
];

/** Block pages are short; real pages quoting one are not. */
const MAX_BLOCK_PAGE_CHARS = 2500;

/**
 * True when a successfully-fetched page is a bot-wall interstitial rather
 * than content. Callers treat this as a RUNG failure — continue the ladder —
 * not as page content, because "Why have I been blocked?" delivered as a
 * successful crawl is data loss disguised as success.
 */
export function looksLikeBlockPage(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_BLOCK_PAGE_CHARS) return false;
  return BLOCK_PAGE_PATTERNS.some((pattern) => pattern.test(trimmed));
}
