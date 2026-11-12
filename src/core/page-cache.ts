// ─── In-process page cache ──────────────────────────────────────────────────
//
// Collapses repeat requests for the same URL inside a short window, so a run
// that reaches one page from several links pays for it once.
//
// Keyed on url + lane set: a result served by the free lane is not
// interchangeable with one a vendor produced. Only successful non-304 results
// are stored — caching a failure would turn a blip into a persistent one.

import type { CrawlResult } from './types.js';

type Entry = { result: CrawlResult; expiresAt: number; chars: number };

const CACHE = new Map<string, Entry>();

/** Bounded so a long-lived process crawling many URLs cannot grow forever. */
const MAX_ENTRIES = 500;
/** And bounded by size: 500 full pages with html could otherwise hold about a gigabyte. */
const MAX_CACHED_CHARS = 50_000_000;
let cachedChars = 0;

/** Test seam. */
export function __clearPageCacheForTests(): void {
  CACHE.clear();
  cachedChars = 0;
}

function drop(key: string): void {
  const entry = CACHE.get(key);
  if (entry) cachedChars -= entry.chars;
  CACHE.delete(key);
}

/** The text a result holds, which is what the cache's size budget counts. */
function charsOf(result: CrawlResult): number {
  if (!result.ok || result.notModified) return 0;
  return result.pages.reduce((sum, page) => sum + page.text.length + (page.markdown?.length ?? 0) + (page.html?.length ?? 0), 0);
}

/**
 * Everything besides the URL that changes what a crawl returns: the lane set (a free result is not
 * interchangeable with a paid one), the output options, the user agent, and the request headers, so a
 * page fetched with one caller's credentials is never replayed to a caller without them.
 */
function keyFor(url: string, lanes: string[] | undefined, variant: string): string {
  return `${(lanes ?? ['own']).join(',')}|${variant}|${url}`;
}

export function readPageCache(url: string, lanes: string[] | undefined, ttlMs: number, variant: string): CrawlResult | null {
  if (!ttlMs || ttlMs <= 0) return null;
  const key = keyFor(url, lanes, variant);
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    drop(key);
    return null;
  }
  // A copy, so a caller that edits its result cannot change what the next hit returns.
  return structuredClone(hit.result);
}

export function writePageCache(url: string, lanes: string[] | undefined, ttlMs: number, result: CrawlResult, variant: string): void {
  if (!ttlMs || ttlMs <= 0) return;
  // Never cache a failure (it may be transient and must stay retryable) or a
  // 304 (its meaning depends on the validators the CALLER sent, so replaying
  // it to a caller who sent none would be a lie).
  if (!result.ok || result.notModified) return;

  const chars = charsOf(result);
  if (chars > MAX_CACHED_CHARS) return;
  const key = keyFor(url, lanes, variant);
  drop(key);
  // Simple FIFO eviction — insertion order is Map's iteration order.
  while (CACHE.size >= MAX_ENTRIES || (cachedChars + chars > MAX_CACHED_CHARS && CACHE.size > 0)) {
    const oldest = CACHE.keys().next().value;
    if (oldest === undefined) break;
    drop(oldest);
  }
  CACHE.set(key, { result, expiresAt: Date.now() + ttlMs, chars });
  cachedChars += chars;
}
