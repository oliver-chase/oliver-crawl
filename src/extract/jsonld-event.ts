// ─── schema.org JSON-LD Event extraction (FR-19) ───────────────────────────
//
// Owner: "getting the information via online search or webcrawl should be
// easier... limit admin having to select fill with AI literally every
// time." jsonld-address.ts already reads a venue's STREET ADDRESS out of
// structured markup for free — this does the same for the event's own
// fields (name/date/price/lineup), which today are read ONLY by the LLM.
// A page that already publishes proper schema.org Event markup gives these
// away for free and deterministically; reading it first means the LLM has
// fewer gaps to guess at (or search-fill later), not that it gets skipped —
// see the scoping note on `applyJsonLdEventBackfill` below for why this
// stays a gap-filler, not a full extraction bypass.

import { readString } from '@/extract/jsonld-address';
import { isSafeHttpUrl } from '@/core/url-safety';

/** One dateText-parser-compatible line for a single ISO date — the parser
 *  (lib/ingestion/date-text-parser.ts) matches "{month name} {day}" plus a
 *  separate 4-digit year, so a raw ISO string ("2026-08-21") would silently
 *  parse to nothing; this formats it into text the parser actually reads.
 *
 *  Reads the calendar date DIRECTLY off the ISO string's own digits, not
 *  via `new Date(iso).getUTC*()` — a caught bug: an evening event with a
 *  non-UTC offset ("2026-08-21T20:00:00-04:00", 8pm Eastern) converts to
 *  the UTC instant 2026-08-22T00:00:00Z, so reading UTC components back
 *  reports the WRONG calendar day (Aug 22 instead of the Aug 21 the venue
 *  actually means). The date written in an ISO string's own YYYY-MM-DD is
 *  always the calendar date as the source intends it, regardless of
 *  offset — string-matching it avoids the conversion entirely. */
function formatIsoDateForParser(iso: string): string | null {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, yearStr, monthStr, dayStr] = match;
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthIndex = Number(monthStr) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return `${months[monthIndex]} ${Number(dayStr)}, ${yearStr}`;
}

/** A price of `""` (a real-world "TBD" placeholder some sites publish)
 *  must NOT read as 0 — `Number('')` is 0, not NaN, so it needs its own
 *  blank check before the numeric parse ever runs. */
function readOfferPrice(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    if (!raw.trim()) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function readOffersPriceText(offers: unknown): string | null {
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  const prices: number[] = [];
  for (const offer of list) {
    if (!offer || typeof offer !== 'object') continue;
    const price = readOfferPrice((offer as Record<string, unknown>).price);
    if (price !== null) prices.push(price);
  }
  if (prices.length === 0) return null;
  if (prices.every((p) => p === 0)) return 'Free';
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? `$${min}` : `$${min}-$${max}`;
}

function readPerformerNames(performer: unknown): string[] | null {
  const list = Array.isArray(performer) ? performer : performer ? [performer] : [];
  const names = list
    .map((p) => (typeof p === 'string' ? p : readString((p as Record<string, unknown>)?.name)))
    .filter((n): n is string => Boolean(n));
  return names.length > 0 ? names : null;
}

/** `location` can validly be a bare string, a single Place object, or (less
 *  commonly) an array of Place options — the first is used for the array
 *  case since there's no signal for which is "the" venue. */
function readLocationName(location: unknown): string | null {
  if (typeof location === 'string') return readString(location);
  if (Array.isArray(location)) return location.length > 0 ? readLocationName(location[0]) : null;
  if (location && typeof location === 'object') return readString((location as Record<string, unknown>).name);
  return null;
}

/** EPIC-6 R7: schema.org's `image` can validly be a bare URL string, a
 *  single ImageObject ({ "@type": "ImageObject", url: "..." }), or an
 *  array of either — same shape ambiguity as `location`. Only a genuinely
 *  safe http(s) URL is ever returned; a `data:`/`javascript:` value (or
 *  anything else isSafeHttpUrl rejects) is dropped rather than stored. */
function readImageUrl(image: unknown): string | null {
  if (typeof image === 'string') return isSafeHttpUrl(image) ? image : null;
  if (Array.isArray(image)) return image.length > 0 ? readImageUrl(image[0]) : null;
  if (image && typeof image === 'object') return readImageUrl((image as Record<string, unknown>).url);
  return null;
}

export type JsonLdEventFields = {
  /** The Event node's own `name` — read in addition to the gap-filler fields
   *  below so a page whose LLM extraction found NOTHING at all (a JS-only
   *  page the deterministic crawl only saw the pre-hydration shell of) can
   *  still be built into a real draft directly from JSON-LD alone (FR-20
   *  Priority 2) — the other fields exist purely to backfill an
   *  LLM-found draft's gaps and were never enough on their own to name
   *  the event. */
  eventName: string | null;
  dateText: string | null;
  venueName: string | null;
  priceText: string | null;
  lineup: string[] | null;
  /** EPIC-6 R6: schema.org Event's own `description` — a real, source-
   *  provided editorial blurb when present, copied verbatim (never
   *  invented). The safest possible source for a "hook" line: structured
   *  data the organizer/venue wrote themselves, not an LLM's reading of
   *  visible text. */
  description: string | null;
  /** EPIC-6 R7: schema.org Event's own `image` — structured data only
   *  (never publicly rendered; see webpage-ingestion-adapter.ts's
   *  WebpageEventDraft.imageUrl doc comment), for potential future ICS/
   *  enrichment/dedup use. */
  imageUrl: string | null;
};

function isEventType(type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === 'string' && t.toLowerCase().includes('event'));
}

/** Collects EVERY schema.org Event-shaped node found (identified by an
 *  `@type` containing "Event", e.g. "Event"/"MusicEvent"/"Festival"),
 *  however deeply nested (an `@graph` array, or wrapped in another
 *  container) — not just the first. A caught bug: returning only the
 *  first match let an unrelated Event node elsewhere on the page (a
 *  "related event" widget, a recurring series' "next date" teaser, a
 *  footer promo) silently supply the wrong date/venue/price for the
 *  page's actual event, with the curator given no signal it came from a
 *  mismatched source. Collecting all of them lets the caller apply the
 *  same "don't guess when ambiguous" rule the multi-draft-page scoping
 *  already uses: only ONE Event node found across the whole page → safe
 *  to use it; more than one → too ambiguous to pick, don't backfill. */
function findAllEventNodes(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const item of node) findAllEventNodes(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;

  const obj = node as Record<string, unknown>;
  if (isEventType(obj['@type'])) out.push(obj);
  for (const value of Object.values(obj)) findAllEventNodes(value, out);
}

function collectEventNodes(scripts: string[]): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  for (const raw of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    findAllEventNodes(parsed, nodes);
  }
  return nodes;
}

function nodeToFields(node: Record<string, unknown>): JsonLdEventFields {
  const startDate = readString(node.startDate);
  return {
    eventName: readString(node.name),
    dateText: startDate ? formatIsoDateForParser(startDate) : null,
    venueName: readLocationName(node.location),
    priceText: readOffersPriceText(node.offers),
    lineup: readPerformerNames(node.performer),
    description: readString(node.description),
    imageUrl: readImageUrl(node.image),
  };
}

/** Given the raw text of every `<script type="application/ld+json">` block
 *  on a page, returns the fields of the SINGLE schema.org Event node found
 *  across all of them, or null if there's zero or more than one (see
 *  `findAllEventNodes`'s comment for why more-than-one isn't just "use the
 *  first"). Each script is parsed independently — one malformed block
 *  doesn't block the rest (malformed JSON-LD is common in the wild). */
export function extractJsonLdEvent(scripts: string[]): JsonLdEventFields | null {
  const nodes = collectEventNodes(scripts);
  const only = nodes[0];
  if (nodes.length !== 1 || !only) return null;
  return nodeToFields(only);
}

/**
 * FR-20 Priority 3: unlike `extractJsonLdEvent` above, returns the fields of
 * EVERY Event node found, in document order — no ambiguity guard, because
 * the caller (ingestion-worker.ts) never picks "the" node here; it feeds
 * each one into the existing dedup pipeline as its own independent
 * candidate, the same fuzzy-match machinery LLM-extracted drafts already go
 * through. This is what makes a multi-event aggregator page's JSON-LD safe
 * to use at all: city/county calendar systems (Simpleview, CivicPlus,
 * WordPress "The Events Calendar") commonly emit one Event node per listed
 * event on the SAME page — positionally correlating node #N to LLM draft
 * #N would be fragile and unordered (the exact bug class the single-node
 * ambiguity guard above was written to prevent, at higher stakes on a
 * multi-draft page).
 */
export function extractAllJsonLdEvents(scripts: string[]): JsonLdEventFields[] {
  return collectEventNodes(scripts).map(nodeToFields);
}
