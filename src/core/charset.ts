// ─── Character encoding detection ───────────────────────────────────────────
//
// `new TextDecoder()` assumes UTF-8. Most of the modern web is UTF-8, so this
// looks fine right up until it isn't — and when it isn't, the failure is
// SILENT: a page served as Windows-1252 decodes "café" as "cafÃ©", "—" as
// "â€"", and nothing throws. The bad text flows into your database, your UI,
// and your LLM prompt looking like ordinary text.
//
// Older municipal, venue and small-business sites — exactly the long tail a
// crawler exists to read — are still routinely served as ISO-8859-1 or
// Windows-1252.
//
// Detection order, most to least authoritative:
//   1. The Content-Type response header (the origin stating it outright)
//   2. A <meta charset> in the first few KB of the document
//   3. UTF-8
//
// Anything the runtime cannot decode falls back to UTF-8 rather than
// throwing: a mangled page is worse than a clean one, but far better than no
// page at all.

const DEFAULT_CHARSET = 'utf-8';

/** Read the charset from a Content-Type header value, if it states one. */
export function charsetFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const match = contentType.match(/charset\s*=\s*["']?([\w-]+)["']?/i);
  return match?.[1] ? match[1].toLowerCase() : null;
}

/**
 * Read `<meta charset>` / `<meta http-equiv="content-type">` from the head of
 * a document. Takes the raw BYTES because the whole point is that we do not
 * yet know how to decode them — the declaration itself is ASCII, so a
 * latin-1 read of the first block is safe for this purpose.
 */
export function charsetFromMetaTag(bytes: Uint8Array): string | null {
  // Only the head matters, and reading further wastes work on a large page.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  const meta = head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i);
  return meta?.[1] ? meta[1].toLowerCase() : null;
}

/** Decode bytes using the best charset evidence available. */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const declared = charsetFromContentType(contentType) ?? charsetFromMetaTag(bytes) ?? DEFAULT_CHARSET;
  try {
    return new TextDecoder(declared).decode(bytes);
  } catch {
    // Unknown/unsupported label — a mangled page beats no page.
    return new TextDecoder(DEFAULT_CHARSET).decode(bytes);
  }
}
