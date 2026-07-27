// ─── Which link probably answers the question? ──────────────────────────────
//
// CRAWL-DETAILLINK-1 (2026-07-27): when a page leaves a field unanswered, the
// answer is usually one click away — parking on /visit, prices on /tickets,
// hours on /faq. Every consumer writes the same "scan the labels for a likely
// link" loop, and `PageLink` already carries `{ url, text }`, so the input is
// here.
//
// The MECHANISM is generic; the vocabulary is not. "parking" meaning a
// parking-notes field is a fact about the caller's domain, not about the web.
// So keywords come from the caller and the ranking lives here — the same
// split used for extraction recipes, where we replay but do not learn.

import type { PageLink } from '../core/types.js';

export type DetailLinkMatch = {
  link: PageLink;
  /** Which of the caller's fields this link plausibly answers. */
  field: string;
  /** Higher is a better match. */
  score: number;
};

/** `{ fieldName: ['keyword', ...] }` — the caller's own vocabulary. */
export type DetailKeywords = Record<string, string[]>;

/**
 * Rank a page's links against the fields you still need.
 *
 * ```ts
 * const picks = pickDetailLinks(page.links, {
 *   parking: ['parking'],
 *   price:   ['ticket', 'price', 'admission'],
 * });
 * ```
 *
 * A link's own text is trusted far more than its URL: an author writing
 * "Parking & Directions" is telling you what is behind the link, whereas a
 * path containing "parking" may just be a section of a larger site. Only the
 * best link per field is returned — following three guesses for one field
 * spends the page budget on speculation.
 */
export function pickDetailLinks(links: PageLink[], keywords: DetailKeywords): DetailLinkMatch[] {
  const bestPerField = new Map<string, DetailLinkMatch>();

  for (const [field, words] of Object.entries(keywords)) {
    for (const link of links) {
      const text = (link.text || '').toLowerCase();
      let path: string;
      try {
        path = new URL(link.url).pathname.toLowerCase();
      } catch {
        path = link.url.toLowerCase();
      }

      let score = 0;
      for (const word of words) {
        const needle = word.toLowerCase();
        if (!needle) continue;
        // Anchor text is the author describing the destination.
        if (text.includes(needle)) score += 10;
        // A path match is weaker corroboration, not proof.
        if (path.includes(needle)) score += 4;
      }
      if (score === 0) continue;

      // Short, specific labels beat long ones: "Parking" is a better bet than
      // "Everything you need to know before you visit, including parking".
      if (text.length > 0 && text.length <= 30) score += 2;

      const current = bestPerField.get(field);
      if (!current || score > current.score) bestPerField.set(field, { link, field, score });
    }
  }

  return [...bestPerField.values()].sort((a, b) => b.score - a.score);
}
