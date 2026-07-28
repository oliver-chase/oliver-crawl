// ─── PDF text extraction (optional peer) ────────────────────────────────────
//
// CRAWL-PDF-1: the parser is an OPTIONAL peer, not a dependency. It is a large
// amount of parsing code over hostile input, and putting that in every
// consumer's install — including the majority who never crawl a PDF — is the
// wrong trade for a library whose value is screening what it fetches.
//
// `npm install unpdf` enables it; without it the rung reports a structural
// failure naming the package rather than skipping silently.
//
// The import uses the same Function-constructor trick as local-render.ts, so
// bundler tracers cannot see it and serverless builds are unaffected.

/** Bound the work: a PDF is untrusted input like everything else here. */
const MAX_PDF_PAGES = 50;

/**
 * PDF-TIMEOUT-1 (found in review): a wall-clock bound on parsing.
 *
 * Every other module that touches remote data has a timeout; this one had
 * none, because it parses bytes rather than fetching them. But those bytes
 * are attacker-supplied, and a malformed or deliberately hostile PDF can send
 * a parser into work that does not finish. Without a bound that hangs the
 * crawl, and a crawl that hangs is worse than one that fails: nothing reports,
 * nothing retries, and the process holds its slot indefinitely.
 */
const PDF_PARSE_TIMEOUT_MS = 20_000;

type UnpdfLike = {
  extractText: (
    data: Uint8Array,
    options?: { mergePages?: boolean },
  ) => Promise<{ text: string | string[]; totalPages?: number }>;
};

async function importPdfParser(): Promise<UnpdfLike | null> {
  try {
    const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<Partial<UnpdfLike>>;
    const mod = await dynamicImport('unpdf');
    return mod && typeof mod.extractText === 'function' ? (mod as UnpdfLike) : null;
  } catch {
    return null;
  }
}

export type PdfExtractResult =
  | { ok: true; text: string; pages: number }
  | { ok: false; reason: 'no_parser' | 'unreadable'; detail: string };

/**
 * Extract the text layer from a PDF.
 *
 * A scanned PDF has no text layer and yields nothing. That is reported as
 * `unreadable` rather than as an empty success, because an empty string
 * presented as a successful extraction would look like a page that genuinely
 * said nothing — and the honest answer is that this document needs a vision
 * model, which is a different decision for the caller to make.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfExtractResult> {
  const parser = await importPdfParser();
  if (!parser) {
    return {
      ok: false,
      reason: 'no_parser',
      detail: 'PDF support needs the optional `unpdf` package. Run `npm install unpdf` to enable it.',
    };
  }

  try {
    // Raced rather than cancelled: the parser exposes no abort signal, so the
    // work may continue in the background — but the crawl is not held by it,
    // and the process can still make progress.
    const extracted = await Promise.race([
      parser.extractText(bytes, { mergePages: true }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`PDF parsing exceeded ${PDF_PARSE_TIMEOUT_MS}ms`)), PDF_PARSE_TIMEOUT_MS),
      ),
    ]);
    const raw = Array.isArray(extracted.text) ? extracted.text.join('\n\n') : extracted.text;
    const text = (raw || '').trim();

    if (!text) {
      return {
        ok: false,
        reason: 'unreadable',
        detail: 'PDF has no text layer (likely scanned images) — it needs a vision model, not a parser.',
      };
    }

    return { ok: true, text, pages: Math.min(extracted.totalPages ?? 0, MAX_PDF_PAGES) };
  } catch (error) {
    return {
      ok: false,
      reason: 'unreadable',
      detail: `PDF could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
