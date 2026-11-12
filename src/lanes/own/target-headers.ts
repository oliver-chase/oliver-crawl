// ─── Request headers from a target ──────────────────────────────────────────

import type { CrawlTarget } from '../../core/types.js';

/** Does this target carry caller-supplied request headers (i.e. credentials)? */
export function hasCredentials(target: CrawlTarget): boolean {
  return Object.keys(targetHeaders(target)).length > 0;
}

/** Headers the crawler owns; a target cannot override them. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'user-agent', 'accept-encoding']);

export function targetHeaders(target: CrawlTarget): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(target.headers ?? {})) {
    if (!RESERVED_HEADERS.has(key.toLowerCase())) out[key.toLowerCase()] = value;
  }
  return out;
}
