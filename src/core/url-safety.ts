// ─── URL safety for values EXTRACTED from crawled pages ─────────────────────
//
// Distinct from fetch/host-policy.ts, and the distinction matters:
//
//   host-policy  — "may the crawler REQUEST this URL?" Same-site, same-port,
//                  https-only, DNS-verified. Strict, because a wrong answer
//                  means an SSRF.
//   url-safety   — "is this URL, which we READ OUT of a page, safe to keep?"
//                  A page can legitimately reference any public host, so
//                  same-site does not apply; what must be refused is
//                  javascript:/data: schemes, credentialed URLs, and anything
//                  pointing at private infrastructure.
//
// Extracted values reach databases, UIs, and LLM prompts, so an unchecked
// `javascript:` href from a crawled page is a stored-XSS vector in whatever
// consumes it. Both guards share core/net-address.ts, so a private range
// added there closes the hole in both at once.

import { isBlockedHostname } from './net-address.js';

const MAX_HTTP_URL_LENGTH = 2048;

/**
 * True when `value` is an http(s) URL safe to store and re-render: a real
 * public hostname, no embedded credentials, no exotic scheme, bounded length.
 */
export function isSafeHttpUrl(value: string): boolean {
  if (!value || value.length > MAX_HTTP_URL_LENGTH) return false;

  try {
    const parsed = new URL(value);
    // Explicit allowlist: everything else (javascript:, data:, file:, ftp:)
    // is refused rather than enumerated.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    if (isBlockedHostname(parsed.hostname)) return false;
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}
