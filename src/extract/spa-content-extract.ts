// ─── SPA content recovery: read the data model, not just the shell ─────────
//
// Site builders (Duda, Wix, Squarespace, Next/Nuxt) render a near-empty
// <body> and ship the actual page content as JSON inside inline <script>
// blocks — so a crawler that strips scripts and reads `$('body').text()` sees
// nothing and the source gets (wrongly) written off as "needs a browser."
// It doesn't: the content is right there in the HTML source. This pulls the
// human-readable string values out of those inline scripts so the existing
// LLM extractor can work over them — free, deterministic, no rendering.
//
// Proven on FreeFall (Duda): recovers dates ("October 9-11, 2026"), lineup
// ("Sam Bush Band"), gate times, and ticket prices — none of which appear in
// the rendered-DOM body text at all.
//
// Used as a FALLBACK only when the visible body text is thin (a real content
// page's own text is always richer and cleaner), so it never degrades normal
// pages — see shouldRecoverFromScripts().

// Below this many visible body chars, treat the page as a shell and try to
// recover content from its inline scripts.
export const THIN_BODY_TEXT_THRESHOLD = 400;

// Decode the common JSON/JS string escapes that appear in embedded data.
function unescapeJsString(input: string): string {
  return input
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\\\/g, '\\');
}

// Looks like human prose/content rather than code or a machine token.
function looksLikeContent(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 12 || trimmed.length > 400) return false;
  if (/^(https?:|data:|blob:|\/|_|#|\.|@|[{}[\]])/.test(trimmed)) return false;
  // Reject code-ish fragments.
  if (/[=;{}]|=>|\bfunction\b|\bvar\b|\bconst\b|\breturn\b|\|\||&&/.test(trimmed)) return false;
  // Require either two adjacent word tokens (prose) or a date/price/time.
  const hasProse = /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(trimmed);
  const hasSignal = /\b(19|20)\d{2}\b|\$\d|\d{1,2}:\d{2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(trimmed);
  return hasProse || hasSignal;
}

/**
 * Extract readable content strings from a page's inline <script> blocks.
 * Returns concatenated, de-duplicated text (longest first, capped at
 * maxChars). Empty string when nothing content-like is found.
 */
export function extractInlineScriptContent(html: string, maxChars = 12_000): string {
  const scripts = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || [];
  const seen = new Set<string>();
  for (const scriptTag of scripts) {
    const bodyStart = scriptTag.indexOf('>') + 1;
    const bodyEnd = scriptTag.lastIndexOf('</');
    const body = bodyStart > 0 && bodyEnd > bodyStart ? scriptTag.slice(bodyStart, bodyEnd) : '';
    if (!body) continue;
    // Every double-quoted string literal in the script.
    const matches = body.match(/"((?:[^"\\]|\\.){12,400})"/g);
    if (!matches) continue;
    for (const raw of matches) {
      const decoded = unescapeJsString(raw.slice(1, -1));
      const value = decoded.replace(/\s+/g, ' ').trim();
      if (looksLikeContent(value)) seen.add(value);
    }
  }
  if (seen.size === 0) return '';
  const ordered = Array.from(seen).sort((a, b) => b.length - a.length);
  let out = '';
  for (const piece of ordered) {
    if (out.length + piece.length + 1 > maxChars) break;
    out += (out ? '\n' : '') + piece;
  }
  return out;
}

/** True when a page's visible body text is thin enough to warrant recovering
 *  content from its inline scripts. */
export function shouldRecoverFromScripts(visibleText: string): boolean {
  return visibleText.replace(/\s+/g, ' ').trim().length < THIN_BODY_TEXT_THRESHOLD;
}
