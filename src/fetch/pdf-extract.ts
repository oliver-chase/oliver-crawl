// ─── PDF text extraction (optional peer) ────────────────────────────────────
//
// CRAWL-PDF-1 (2026-07-27). Suppliers, municipalities and venues routinely
// publish a whole season, catalogue or specification as a single PDF, and the
// fetch rung refused `application/pdf` outright — so the most complete
// document on the site was the one document we could not read.
//
// ── Why this is an OPTIONAL peer, not a dependency ──
//
// A PDF parser is a large amount of parsing code operating on hostile input.
// Adding it as a hard dependency would put that surface into every consumer's
// install, including the majority who never crawl a PDF — in a library whose
// stated value is screening what it fetches, that trade is backwards.
//
// So it follows the same pattern as the Chromium rung: the parser is imported
// only at real runtime, and its absence means the rung skips rather than the
// crawl failing. A consumer who wants PDFs installs it:
//
//   npm install unpdf
//
// and PDFs start being read. A consumer who does not gets a `structural`
// failure naming the missing package, which is honest and actionable.
//
// THE IMPORT TRICK: a plain `import('unpdf')` is constant-folded by bundler
// tracers, which then try to resolve the parser's own optional deps and break
// serverless builds for consumers who never wanted it. A Function-constructor
// import is invisible to every tracer — see local-render.ts, which learned
// this the hard way.

/** Bound the work: a PDF is untrusted input like everything else here. */
const MAX_PDF_PAGES = 50;

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
    const extracted = await parser.extractText(bytes, { mergePages: true });
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
