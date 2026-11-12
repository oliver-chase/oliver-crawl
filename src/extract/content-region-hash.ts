// ─── Content-region hashing ──────────────────────────────────────
//
// An unchanged-page skip that hashes the WHOLE page body — a nav banner date, a
// footer copyright year, or an ad script's cache-busting query param
// changing is enough to make the whole-page hash differ, re-triggering a
// full extraction for a page whose actual content never changed.
// This computes a SECOND hash of just the main-content region; the caller
// treats a page as unchanged when EITHER hash still matches.
//
// The region is the one the markdown reads (selectMainRegion), with the same page
// furniture removed, so an edit to any text the markdown shows changes the hash.

import * as cheerio from 'cheerio';
import { sha256Hex } from '../core/hash.js';
import { CHROME_SELECTOR, selectMainRegion } from './main-region.js';

/**
 * Returns the visible text of the page's main-content region, with chrome
 * (nav/header/footer/aside) and non-visible tags (script/style/noscript) removed.
 * Exported for direct testing.
 */
export function extractMainContentText(html: string): string {
  const region = selectMainRegion(cheerio.load(html));
  if (region.length === 0) return '';
  const scope = region.clone();
  scope.find(CHROME_SELECTOR).remove();
  return scope.text().replace(/\s+/g, ' ').trim();
}

/** Hashes the extracted main-content text. Never throws — an empty/unparsed
 *  page just hashes an empty string, which will simply never match a prior
 *  non-empty hash (correctly treated as "changed," the safe default). */
export async function computeContentRegionHash(html: string): Promise<string> {
  return sha256Hex(extractMainContentText(html));
}
