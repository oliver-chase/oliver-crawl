// ─── In-process page cache ──────────────────────────────────────────────────
//
// Stops the same URL being fetched twice in quick succession by the same
// process.
//
// crawlSite dedupes within ONE run, but that is the only protection there
// was: two runs, or two independent callers, or a detail page reachable from
// two listing pages, all re-fetched. For an origin that looks like a repeat
// visitor for no reason; for the caller it is latency and bandwidth spent to
// learn something already known.
//
// Deliberately small in scope:
//   - in-memory only, so it dies with the process (a persistent cache is a
//     consumer's decision, and they already have `validators` for that)
//   - short TTL, because it is a stampede guard, not a content store
//   - OFF by default — a cache that turns itself on is a cache that serves a
//     stale page to someone who did not ask for one
//   - only successful, non-304 results are cached; failures must be retryable

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
