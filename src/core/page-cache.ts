// ─── In-process page cache ──────────────────────────────────────────────────
//
// Collapses repeat requests for the same URL inside a short window, so a run
// that reaches one page from several links pays for it once.
//
// Keyed on url + lane set: a result served by the free lane is not
// interchangeable with one a vendor produced. Only successful non-304 results
// are stored — caching a failure would turn a blip into a persistent one.

import type { CrawlResult } from './types.js';

type Entry = { result: CrawlResult; expiresAt: number };

const CACHE = new Map<string, Entry>();

/** Bounded so a long-lived process crawling many URLs cannot grow forever. */
const MAX_ENTRIES = 500;

/** Test seam. */
export function __clearPageCacheForTests(): void {
  CACHE.clear();
}

function keyFor(url: string, lanes: string[] | undefined): string {
  // The lane set is part of the key: a result served by the free lane is not
  // interchangeable with one a caller asked the paid lane for.
  return `${(lanes ?? ['own']).join(',')}|${url}`;
}

export function readPageCache(url: string, lanes: string[] | undefined, ttlMs: number): CrawlResult | null {
  if (!ttlMs || ttlMs <= 0) return null;
  const key = keyFor(url, lanes);
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    CACHE.delete(key);
    return null;
  }
  return hit.result;
}

export function writePageCache(url: string, lanes: string[] | undefined, ttlMs: number, result: CrawlResult): void {
  if (!ttlMs || ttlMs <= 0) return;
  // Never cache a failure (it may be transient and must stay retryable) or a
  // 304 (its meaning depends on the validators the CALLER sent, so replaying
  // it to a caller who sent none would be a lie).
  if (!result.ok || result.notModified) return;

  if (CACHE.size >= MAX_ENTRIES) {
    // Simple FIFO eviction — insertion order is Map's iteration order.
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
  CACHE.set(keyFor(url, lanes), { result, expiresAt: Date.now() + ttlMs });
}
