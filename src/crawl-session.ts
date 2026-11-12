// ─── Store session for a site crawl ─────────────────────────────────────────
//
// CRAWL-STORE-1: what one run reads from and writes to its CrawlStore: the recrawl schedule, the sitemap
// dates of checked URLs, and the throttled, ordered saves. crawlSite decides when; this keeps the state.

import type { CrawlProgress, SiteCrawlResult } from './crawl-site-types.js';
import type { CrawlState, CrawlStore, ScheduleEntry } from './crawl-store.js';

export function createStoreSession(args: {
  store: CrawlStore;
  storeKey: string;
  /** False when the caller gave no store: a run then keeps nothing, and copying state for it would cost O(pages squared). */
  persistEnabled: boolean;
  storeIntervalMs: number;
  loaded: CrawlState | null;
  validators: SiteCrawlResult['validators'];
  /** The sitemap date of every URL the sitemap listed this run. */
  lastmod: Record<string, string>;
}) {
  const { store, storeKey, persistEnabled, storeIntervalMs, loaded, validators, lastmod } = args;
  const schedule: Record<string, ScheduleEntry> = { ...(loaded?.schedule ?? {}) };
  // Only a URL that was actually checked keeps its date, so a page that failed this run is not skipped on the next.
  const checkedLastmod: Record<string, string> = { ...(loaded?.lastmod ?? {}) };
  let saving: Promise<void> = Promise.resolve();
  let lastSavedAt = 0;
  let storeError: string | undefined;

  return {
    schedule,
    persist(progress: CrawlProgress | null, final = false): void {
      if (!persistEnabled) return;
      if (!final && Date.now() - lastSavedAt < storeIntervalMs) return;
      lastSavedAt = Date.now();
      // Chained, so snapshots reach the store in order, and a failing store cannot reach the crawl.
      const state: CrawlState = { progress, schedule: { ...schedule }, validators: { ...validators }, lastmod: { ...checkedLastmod } };
      saving = saving
        .then(() => store.save(storeKey, state))
        .catch((error: unknown) => {
          storeError ??= error instanceof Error ? error.message : String(error);
        });
    },
    /** The first error a save threw, or undefined. The crawl keeps running, and the result reports it. */
    storeError: (): string | undefined => storeError,
    /** Resolves once every save started so far has finished. */
    settled: (): Promise<void> => saving,
    /**
     * A page that redirected is recorded under the URL that was listed as well as the one it ended on, so the
     * sitemap date and the schedule are found again next run.
     */
    touch(key: string, unchangedNow: boolean, requested = key): void {
      for (const name of new Set([key, requested])) {
        if (lastmod[name]) checkedLastmod[name] = lastmod[name];
        schedule[name] = {
          checkedAt: Date.now(),
          unchangedStreak: unchangedNow ? (schedule[name]?.unchangedStreak ?? 0) + 1 : 0,
        };
      }
    },
  };
}
