// ─── Which image on this page is the content? ───────────────────────────────
//
// CRAWL-VISION-1: municipal and venue pages routinely publish the
// real detail — dates, lineup, time, address, parking — inside ONE poster or
// flyer image, with almost nothing in the page text. Today such a page parses
// fine, yields no meaningful text, walks the whole free ladder, and reports
// `unreachable`. The content was there the entire time.
//
// The split follows every other lane boundary here:
//
//   ours (free):    find the image(s) plausibly carrying the content
//   caller's (paid): run a vision model over them
//
// Shipping only the free half is useful on its own — a caller can decide
// whether an image is worth paying to read, which is a decision they can only
// make if they know the image exists.
//
// This is a RANKING, not a verdict. It never claims an image contains text;
// it claims these are the ones worth looking at first.

import type { CheerioAPI, Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { selectMainRegion } from './html-to-markdown.js';

/** Filename/path fragments that mark an image as furniture, not content. */
const FURNITURE_PATTERN =
  /(^|[/_-])(logo|icon|favicon|sprite|avatar|badge|banner-ad|advert|pixel|spacer|placeholder|thumb|thumbnail|arrow|bullet|divider|social|facebook|twitter|instagram)([/_.-]|$)/i;

/** Extensions that are never a scanned flyer. */
const NON_PHOTO_EXTENSION = /\.(svg|gif|ico)(\?|#|$)/i;

export type ContentImage = {
  url: string;
  /** The image's alt text, which is frequently the only description of it. */
  alt: string;
  /** Higher is more likely to be the page's real content. */
  score: number;
};

/**
 * Rank the images most likely to carry this page's actual content.
 *
 * Scoring favours, in rough order of weight: living inside the main content
 * region rather than page chrome, declaring poster-ish dimensions, and having
 * descriptive alt text. It penalises anything whose URL looks like site
 * furniture.
 *
 * Returns at most `limit` images, best first, and an empty array when nothing
 * plausible is present — which is the common and correct answer for an
 * ordinary text page.
 */
export function findContentImages($: CheerioAPI, pageUrl: string, limit = 3): ContentImage[] {
  const region = selectMainRegion($);
  const inRegion = new Set<AnyNode>();
  region.find('img').each((_, img) => {
    inRegion.add(img);
  });

  const seen = new Set<string>();
  const candidates: ContentImage[] = [];

  $('img').each((_, img) => {
    const $img = $(img) as Cheerio<AnyNode>;
    const raw = ($img.attr('src') || $img.attr('data-src') || '').trim();
    if (!raw) return;

    let url: string;
    try {
      url = new URL(raw, pageUrl).toString();
    } catch {
      return;
    }
    if (!/^https?:/i.test(url) || seen.has(url)) return;
    seen.add(url);

    if (FURNITURE_PATTERN.test(url) || NON_PHOTO_EXTENSION.test(url)) return;

    const width = Number($img.attr('width')) || 0;
    const height = Number($img.attr('height')) || 0;
    // A declared tiny image is a spacer or an icon, whatever it is called.
    if ((width > 0 && width < 200) || (height > 0 && height < 200)) return;

    const alt = ($img.attr('alt') || '').trim();

    let score = 0;
    // Being in the content region is the strongest single signal: a flyer is
    // published as content, and nav/footer images are furniture by definition.
    if (inRegion.has(img)) score += 10;
    // Declared large — a poster, not a decoration.
    if (width >= 600 || height >= 600) score += 5;
    else if (width >= 300 || height >= 300) score += 2;
    // Portrait-ish is flyer-shaped; wide banners usually are not.
    if (width > 0 && height > 0 && height >= width) score += 3;
    // Real alt text means someone described it, which they do for content.
    if (alt.length >= 15) score += 3;
    else if (alt.length > 0) score += 1;
    // Words that show up in the filenames of actual flyers.
    if (/(flyer|poster|schedule|calendar|lineup|program|brochure|menu)/i.test(url)) score += 4;

    if (score > 0) candidates.push({ url, alt, score });
  });

  return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
}
