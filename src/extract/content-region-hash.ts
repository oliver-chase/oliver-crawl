// ─── Content-region hashing ──────────────────────────────────────
//
// An unchanged-page skip that hashes the WHOLE page body — a nav banner date, a
// footer copyright year, or an ad script's cache-busting query param
// changing is enough to make the whole-page hash differ, re-triggering a
// full extraction for a page whose actual content never changed.
// This computes a SECOND hash of just the main-content region; the caller
// treats a page as unchanged when EITHER hash still matches.
//
// The hash reads the page's Markdown, so a change to any text, link or image the
// Markdown shows changes it, and chrome the Markdown leaves out never does.

import * as cheerio from 'cheerio';
import { sha256Hex } from '../core/hash.js';
import { htmlToMarkdown } from './html-to-markdown.js';

/** The page's main content as the hash reads it: its full Markdown, chrome removed. Exported for direct testing. */
export function extractMainContentText(html: string, pageUrl?: string): string {
  return htmlToMarkdown(cheerio.load(html), pageUrl ? { baseUrl: pageUrl } : {});
}

/**
 * Hash of the page's main content. Pass the page URL to match a crawled page's
 * `contentRegionSha256`, since relative links resolve against it. Never throws: an
 * empty page hashes the empty string, which never matches a non-empty one.
 */
export async function computeContentRegionHash(html: string, pageUrl?: string): Promise<string> {
  return sha256Hex(extractMainContentText(html, pageUrl));
}
