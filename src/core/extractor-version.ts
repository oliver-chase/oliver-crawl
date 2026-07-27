// ─── Extraction version ─────────────────────────────────────────────────────
//
// CRAWL-CONTENTKIND-1: bump this whenever text, markdown, link or JSON-LD
// extraction changes in a way that would produce a DIFFERENT result for the
// same bytes.
//
// Without it, improving the extractor only ever helps pages crawled after the
// improvement shipped: a consumer holding a stored page has no way to ask
// "was this produced by an older, worse version?" and so never re-processes.
// It cannot be added retroactively with any value — a page stored before this
// existed has no version to compare.
//
// Not the package version: a bugfix to the SSRF guard changes no extraction
// output and must not invalidate every stored page.
export const EXTRACTOR_VERSION = '1';
