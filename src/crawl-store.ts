// ─── Crawl state store ──────────────────────────────────────────────────────
//
// CRAWL-STORE-1: where a crawl keeps the things that must outlive one process: its queue, the
// validators that make the next run cheap, and when each URL is next due. The library still
// ships no database. A consumer implements `CrawlStore` over whatever it already runs (a row,
// a file, a key-value entry), and `crawlSite` reads it at the start and writes it as it goes.
// Without a store, an in-memory one is used and nothing outlives the call.

import type { CrawlProgress, SiteCrawlResult } from './crawl-site-types.js';

/** One URL's place in the recrawl schedule. */
export type ScheduleEntry = {
  /** Epoch ms of the last check. */
  checkedAt: number;
  /** Consecutive checks that found the page unchanged. */
  unchangedStreak: number;
};

/** Plain JSON, so a store can hold it in a row, a file or a queue message. */
export type CrawlState = {
  /** Where an unfinished run stopped, or null when the last run completed. */
  progress: CrawlProgress | null;
  schedule: Record<string, ScheduleEntry>;
  validators: SiteCrawlResult['validators'];
  /** The sitemap `<lastmod>` each URL had when it was last checked, so the next run can skip a page the sitemap says has not moved. */
  lastmod?: Record<string, string>;
};

export interface CrawlStore {
  load(key: string): CrawlState | null | Promise<CrawlState | null>;
  save(key: string, state: CrawlState): void | Promise<void>;
}

/** The default store: lives as long as the object does. */
export function createMemoryCrawlStore(): CrawlStore {
  const states = new Map<string, CrawlState>();
  return {
    load: (key) => states.get(key) ?? null,
    save: (key, state) => {
      states.set(key, structuredClone(state));
    },
  };
}

export const DEFAULT_RECRAWL_MIN_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_RECRAWL_MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Is this URL due for another look? Every unchanged check doubles the wait, from the minimum up
 * to the maximum, and a change resets it. A page that moves daily is visited at the minimum
 * interval, and one that never moves settles at the maximum.
 */
export function isDue(entry: ScheduleEntry | undefined, now: number, minMs: number, maxMs: number): boolean {
  if (!entry) return true;
  const interval = Math.min(maxMs, minMs * 2 ** Math.min(entry.unchangedStreak, 30));
  return now - entry.checkedAt >= interval;
}
