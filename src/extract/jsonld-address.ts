// ─── schema.org JSON-LD address extraction (FG-4) ──────────────────────────
//
// Root cause of the map's missing pins: nothing in the ingestion pipeline
// ever captured a venue's STREET ADDRESS, only its name — and Nominatim
// can't resolve names like "Homesteads for Hope farm" the way it can resolve
// "27 West Avenue, Spencerport, NY". Meanwhile municipal/venue sites often
// already publish exactly this as structured schema.org markup
// (visitrochester's JSON-LD literally contains "2185 Manitou Rd"). Reading
// it is free, deterministic, and zero LLM cost — the highest-leverage fix
// in the pipeline, so it runs BEFORE any LLM extraction, not as a fallback.
//
// Deliberately address-only, not geo (lat/lng): a page can carry more than
// one JSON-LD block (a sitewide Organization schema alongside the specific
// event's own markup), so the first streetAddress found isn't guaranteed to
// be the right entity. Feeding it through the EXISTING geocodeWithReview
// confidence pipeline (rather than trusting an asserted lat/lng directly)
// keeps the same safety net: a wrong or mismatched address still resolves
// to a low-confidence review task instead of a silently wrong pin — it just
// resolves with a real address instead of a bare venue name, which is what
// actually gets it past Nominatim's rooftop/street match threshold.

export type JsonLdAddress = {
  streetAddress: string;
  city: string | null;
  state: string | null;
  postalCode: string | null;
};

/** Shared with jsonld-event.ts — one home for the "trimmed string or null"
 *  read every JSON-LD field extractor needs. */
export function readString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

/** Depth-first search for the first schema.org PostalAddress-shaped node
 *  (identified by its `streetAddress` field, however deeply nested — under
 *  `location.address`, `address`, or any other schema.org container). */
function findAddress(node: unknown): JsonLdAddress | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findAddress(item);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;

  const obj = node as Record<string, unknown>;
  const streetAddress = readString(obj.streetAddress);
  if (streetAddress) {
    return {
      streetAddress,
      city: readString(obj.addressLocality),
      state: readString(obj.addressRegion),
      postalCode: readString(obj.postalCode),
    };
  }
  for (const value of Object.values(obj)) {
    const found = findAddress(value);
    if (found) return found;
  }
  return null;
}

/** Given the raw text content of every `<script type="application/ld+json">`
 *  block on a page, returns the first usable address found, or null. Each
 *  script is parsed independently — one malformed block doesn't block the
 *  rest (malformed JSON-LD is common in the wild). */
export function extractJsonLdAddress(scripts: string[]): JsonLdAddress | null {
  for (const raw of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const found = findAddress(parsed);
    if (found) return found;
  }
  return null;
}

/** One free-form line for the geocoder query — "27 West Avenue, Spencerport, NY 14559". */
export function formatJsonLdAddress(address: JsonLdAddress): string {
  return [address.streetAddress, address.city, address.state, address.postalCode].filter(Boolean).join(', ');
}
