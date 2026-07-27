// ─── EPIC-3 C1: content-region hashing ──────────────────────────────────────
//
// The unchanged-page skip (GAP-4d, source-reference-upsert.ts's
// findUnchangedUrls) hashes the WHOLE page body — a nav banner date, a
// footer copyright year, or an ad script's cache-busting query param
// changing is enough to make the whole-page hash differ, re-triggering a
// full LLM extraction for a page whose actual EVENT content never changed.
// This computes a SECOND hash of just the main-content region; the caller
// treats a page as unchanged when EITHER hash still matches (see
// source-reference-upsert.ts).
//
// Pure string/regex, not a cheerio DOM — reusable by both the html lane
// (which parses with cheerio) and the browser lane (which extracts text via
// its own regex helpers, no cheerio dependency) without adding a DOM library
// to either. Matches this codebase's existing lightweight-regex convention
// (feed-discovery.ts, secure-browser-runner.ts's extractPageLinks).

import { sha256Hex } from '@/core/hash';

const CHROME_TAGS = ['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript'];

function stripTagBlocks(html: string, tagNames: string[]): string {
  let out = html;
  for (const tag of tagNames) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }
  return out;
}

function stripTagsToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extracts the first `<main>...</main>` or `<article>...</article>` block's
 *  inner HTML, when present — the tightest, most reliable scope. Non-greedy
 *  match to the FIRST matching close tag; nested main/article tags are
 *  invalid HTML anyway (at most one `<main>` per page per spec), so this
 *  doesn't need real tag-depth tracking. */
function extractSemanticContentBlock(html: string): string | null {
  for (const tag of ['main', 'article']) {
    const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    if (match && match[1] !== undefined) return match[1];
  }
  return null;
}

/**
 * Returns the visible text of the page's "main content" — a `<main>`/
 * `<article>` block when the page has one, else the whole page with
 * chrome regions (nav/header/footer/aside) and non-visible tags
 * (script/style/noscript) stripped out. Exported for direct testing.
 */
export function extractMainContentText(html: string): string {
  const semanticBlock = extractSemanticContentBlock(html);
  if (semanticBlock) return stripTagsToText(stripTagBlocks(semanticBlock, ['script', 'style', 'noscript']));
  return stripTagsToText(stripTagBlocks(html, CHROME_TAGS));
}

/** Hashes the extracted main-content text. Never throws — an empty/unparsed
 *  page just hashes an empty string, which will simply never match a prior
 *  non-empty hash (correctly treated as "changed," the safe default). */
export async function computeContentRegionHash(html: string): Promise<string> {
  return sha256Hex(extractMainContentText(html));
}
