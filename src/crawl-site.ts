// ─── Multi-page crawl orchestrator ──────────────────────────────────────────
//
// Drives the single-page crawl across a target's seeds, optionally following
// pagination, and returns one result for the whole run.
//
// Everything here is a LOOP over parts that already exist — policy, fetch,
// render, guard, hashing all live in the lanes. This module owns only the
// things a single page cannot decide for itself:
//
//   - which URLs to visit (seeds, then discovered next-pages)
//   - how many, in total (a hard page budget — a crawl must be bounded)
//   - what to do when one page fails (retry, unless retrying is pointless)
//   - not visiting the same URL twice
//   - reporting per-URL outcomes without letting one bad page sink the run
//
// Sequential by default, parallel on request: the origin implementation ran
// `maxConcurrency: 1`, and hammering a small venue site with parallel requests
// is what gets a crawler blocked. `concurrency` raises the global ceiling and
// `perHostConcurrency` (default 1) keeps each host to one request at a time, so
// a crawl across many hosts runs in parallel while every host stays polite.

import { urlDedupKey } from './core/url-dedup-key.js';
import { createNearDuplicateIndex } from './extract/near-duplicate.js';
import { createHostStats, hostOf } from './crawl-host-stats.js';
import { createPageProcessor } from './crawl-page.js';
import { resolveSeeds } from './crawl-seeds.js';
import { createStoreSession } from './crawl-session.js';
import {
  DEFAULT_RECRAWL_MAX_INTERVAL_MS,
  DEFAULT_RECRAWL_MIN_INTERVAL_MS,
  createMemoryCrawlStore,
  isDue,
} from './crawl-store.js';
import type { CrawlState } from './crawl-store.js';
import { releaseHostSlot, sleep, tryAcquireHostSlot } from './core/host-throttle.js';
import { assertRequestUrlAllowed, assertTargetEligible } from './fetch/host-policy.js';
import type { Crawler } from './index.js';
import { DEFAULT_MAX_PAGES } from './core/types.js';
import type { CrawlPage, CrawlTarget } from './core/types.js';
import type { CrawlProgress, HostStats, MultiSiteOptions, MultiSiteResult, SiteCrawlFailure, SiteCrawlOptions, SiteCrawlResult } from './crawl-site-types.js';

export type { CrawlProgress, HostStats, MultiSiteOptions, MultiSiteResult, SiteCrawlFailure, SiteCrawlOptions, SiteCrawlResult };

const DEFAULT_MAX_RETRIES = 1;

/**
 * Crawl a whole site: seeds, discovery, budgets, dedup and resume.
 *
 * Takes a `Crawler` so lane selection, budgeting and
 * usage reporting come along for free — this orchestrator never needs to know
 * which lane served a page.
 */
export async function crawlSite(
  crawler: Crawler,
  target: CrawlTarget,
  options: SiteCrawlOptions = {},
): Promise<SiteCrawlResult> {
  const startedAt = new Date().toISOString();

  // CRAWL-STORE-1: what an earlier run, possibly on another worker, left behind.
  const store = options.store ?? createMemoryCrawlStore();
  const storeKey = options.storeKey ?? options.targetId ?? target.baseUrl;
  let loaded: CrawlState | null = null;
  let loadError: string | undefined;
  try {
    loaded = await store.load(storeKey);
  } catch (error) {
    // A store that cannot be read is treated as empty: the crawl runs, it just starts from scratch.
    loadError = error instanceof Error ? error.message : String(error);
  }
  const validators: SiteCrawlResult['validators'] = {};
  const lastmod: Record<string, string> = {};
  const session = createStoreSession({ store, storeKey, persistEnabled: Boolean(options.store), storeIntervalMs: options.storeIntervalMs ?? 1000, loaded, validators, lastmod });
  const schedule = session.schedule;
  options = {
    ...options,
    resumeFrom: options.resumeFrom ?? loaded?.progress ?? undefined,
    priorValidators: { ...(loaded?.validators ?? {}), ...(options.priorValidators ?? {}) },
    // SITEMAP-LASTMOD-STORE-1: the dates the store kept skip unchanged sitemap entries with no caller plumbing.
    priorLastmod: { ...(loaded?.lastmod ?? {}), ...(options.priorLastmod ?? {}) },
  };
  const recrawlMin = Math.max(1, options.recrawlMinIntervalMs ?? DEFAULT_RECRAWL_MIN_INTERVAL_MS);
  const recrawlMax = Math.max(recrawlMin, options.recrawlMaxIntervalMs ?? DEFAULT_RECRAWL_MAX_INTERVAL_MS);
  const notDue: string[] = [];
  let lastProgress: CrawlProgress | null = options.resumeFrom ?? null;
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);

  const pages: CrawlPage[] = [];
  const notModified: string[] = [];
  const failures: SiteCrawlFailure[] = [];
  const unchanged: string[] = [];
  const skippedByLastmod: string[] = [];
  const duplicates: SiteCrawlResult['duplicates'] = [];
  const nearDuplicates = createNearDuplicateIndex(options.nearDuplicateDistance ?? 3);
  const stats = createHostStats();

  const done = async (truncated: boolean, ran = true): Promise<SiteCrawlResult> => {
    // A finished run clears its snapshot, and a truncated one keeps it so the next run continues.
    // A run refused before it started leaves the stored snapshot as it was.
    if (ran) session.persist(truncated ? lastProgress : null, true);
    await session.settled();
    const storeError = loadError ?? session.storeError();
    // Deliver fresh validators to the consumer's persistence hook, fire-and-
    // forget: a slow or throwing sink must not break (or slow) the crawl.
    if (Object.keys(validators).length > 0 && options.onSignals) {
      // Wrapped in a promise so a sink that throws, or returns a rejected promise, cannot reach the crawl.
      void Promise.resolve()
        .then(() => options.onSignals!(options.targetId ?? target.baseUrl, validators))
        .catch(() => {});
    }
    return {
      pages,
      notModified,
      failures,
      truncated,
      validators,
      unchanged,
      lastmod,
      skippedByLastmod,
      notDue,
      ...(storeError === undefined ? {} : { storeError }),
      duplicates,
      hosts: stats.snapshot(),
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  };

  // CRAWLSITE-AUTOROBOTS-1: resolve the posture BEFORE the eligibility gate.
  // That gate fails closed on an unknown policy, and autoRobots resolution
  // used to happen only inside the lane — so a whole-site crawl of a target
  // with no stored policy was refused outright, while a single-page crawl of
  // the same URL succeeded. One request per host, cached.
  target = await crawler.resolveTarget(target);

  // Eligibility is a property of the TARGET, not of any one URL — check it
  // once, and report it as a single failure.
  try {
    assertTargetEligible(target);
  } catch (error) {
    failures.push({
      url: target.baseUrl,
      reason: 'blocked',
      detail: error instanceof Error ? error.message : String(error),
    });
    return done(false, false);
  }

  const seeded = await resolveSeeds(crawler, target, options, maxPages);
  Object.assign(lastmod, seeded.lastmod);
  skippedByLastmod.push(...seeded.skippedByLastmod);
  const rawSeeds = seeded.seeds;

  const queue: string[] = [];
  for (const seed of rawSeeds) {
    try {
      queue.push(assertRequestUrlAllowed(target, seed).toString());
    } catch (error) {
      failures.push({ url: seed, reason: 'blocked', detail: error instanceof Error ? error.message : String(error) });
    }
  }

  // CRAWL-STORE-1: URLs a sitemap listed are skipped until they are due. Explicit seeds and the base
  // URL always run, since the caller asked for them and they are where link discovery starts.
  if (seeded.fromSitemap && !options.resumeFrom) {
    const now = Date.now();
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!isDue(schedule[queue[i]!], now, recrawlMin, recrawlMax)) notDue.unshift(...queue.splice(i, 1));
    }
  }

  // Dedup across seeds AND everything discovered — a site whose page 2 links
  // back to page 1, or whose nav links every page to every other page, must
  // not loop.
  // Keyed on the canonical resource identity, not the raw string — see
  // core/url-dedup-key.ts. /events, /events/, /events#lineup and
  // /events?utm_source=x are one page, and must cost one slot of maxPages.
  const visited = new Set<string>(options.resumeFrom?.visited ?? []);
  const maxDepth = Math.max(0, options.maxDepth ?? 2);
  // Depth rides alongside the URL so breadth-first ordering is preserved and
  // a deep branch cannot consume the whole page budget.
  const depthOf = new Map<string, number>();
  for (const seed of queue) depthOf.set(urlDedupKey(seed), 0);
  // Restored depths win over the seed default, so a resumed run cannot
  // silently reset a deep page back to depth 0 and blow past maxDepth.
  for (const [key, depth] of Object.entries(options.resumeFrom?.depths ?? {})) {
    depthOf.set(key, depth);
  }

  // A pattern with the g or y flag keeps its position between calls, so each test starts from 0.
  const matches = (pattern: RegExp, candidate: string) => {
    pattern.lastIndex = 0;
    return pattern.test(candidate);
  };
  const shouldSkip = (candidate: string) => {
    if ((options.excludePatterns ?? []).some((pattern) => matches(pattern, candidate))) return true;
    const include = options.includePatterns;
    // Allowlist, when given: anything not named is not followed.
    return Boolean(include?.length) && !include!.some((pattern) => matches(pattern, candidate));
  };

  /** Queue a discovered URL if it is same-site, unseen, and within depth. */
  const enqueue = (rawUrl: string, depth: number) => {
    if (depth > maxDepth) return;
    if (shouldSkip(rawUrl)) return;
    try {
      const safe = assertRequestUrlAllowed(target, rawUrl).toString();
      const key = urlDedupKey(safe);
      if (visited.has(key) || depthOf.has(key)) return;
      depthOf.set(key, depth);
      // CRAWL-STORE-1: a discovered page that is not due yet is remembered as seen and left alone.
      if (!isDue(schedule[safe], Date.now(), recrawlMin, recrawlMax)) {
        notDue.push(safe);
        return;
      }
      // The QUEUE keeps the real URL — we request exactly what the site
      // published. Only identity is normalised.
      queue.push(safe);
    } catch {
      // Off-site or unsafe — not an error, just not ours to follow.
    }
  };

  // Pages a resumed run already collected count against maxPages.
  const alreadyCollected = options.resumeFrom?.collected ?? 0;
  const deadline = options.maxDurationMs ? Date.now() + options.maxDurationMs : Infinity;

  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const perHost = Math.max(1, Math.floor(options.perHostConcurrency ?? 1));
  /** urlKey -> url for every fetch in flight, so a snapshot can keep them. */
  const running = new Map<string, string>();
  // CRAWL-BUDGET-1: maxPages bounds fetches. Failures and near-duplicates spend the budget too, so a site
  // that fails or repeats cannot make a run fetch without limit.
  let attempted = 0;
  const collectedSoFar = () => alreadyCollected + attempted - running.size;

  const processUrl = createPageProcessor({
    crawler,
    target,
    options,
    maxRetries,
    pages,
    notModified,
    failures,
    validators,
    unchanged,
    duplicates,
    visited,
    nearDuplicates,
    stats,
    touch: session.touch,
    enqueue,
  });

  const inFlight = new Set<Promise<void>>();

  const launch = (url: string, urlKey: string, depth: number) => {
    const host = hostOf(url);
    running.set(urlKey, url);
    attempted += 1;
    const task = processUrl(url, urlKey, depth)
      // A page that throws is one failure, so the rest of the run continues.
      .catch((error: unknown) => {
        failures.push({ url, reason: 'unreachable', detail: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        running.delete(urlKey);
        releaseHostSlot(host);
      })
      .then(async () => {
        // CRAWL-RESUME-1: emitted AFTER the URL is marked visited and after
        // any discovery it produced is queued, so a snapshot is always a
        // coherent "everything up to here is done" — never one that would
        // re-fetch the page just handled, or lose the links it found.
        //
        // Emitted for failures too: a page that failed terminally is finished
        // with, and a resume that retried it would repeat the same failure.
        //
        // CRAWL-PARALLEL-1: pages still in flight are not done, so they go
        // back at the head of the queue and out of the visited set.
        // The snapshot copies the visited set and depths, so it is built only when a store or an
        // onProgress callback will read it. Building it for every page costs time quadratic in the page count.
        if (options.store || options.onProgress) {
          lastProgress = {
            queue: [...running.values(), ...queue],
            visited: [...visited].filter((key) => !running.has(key)),
            depths: Object.fromEntries(depthOf),
            collected: collectedSoFar(),
          };
          session.persist(lastProgress);
          options.onProgress?.(lastProgress);
        }
        if ((options.politenessDelayMs ?? 0) > 0 && queue.length > 0) {
          await sleep(options.politenessDelayMs!);
        }
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
  };

  for (;;) {
    let hostBlocked = false;
    while (queue.length > 0 && running.size < concurrency) {
      // Stop starting work at the page or time budget; what is in flight finishes.
      if (alreadyCollected + attempted >= maxPages) break;
      // Stop cleanly on the time budget, keeping everything gathered so far —
      // a partial result is far more useful than an aborted run.
      if (Date.now() >= deadline) break;

      let next = -1;
      for (let i = 0; i < queue.length; i++) {
        if (visited.has(urlDedupKey(queue[i]!))) {
          queue.splice(i, 1);
          i--;
          continue;
        }
        // The slot is process-wide, so another crawl on the same host counts too.
        if (tryAcquireHostSlot(hostOf(queue[i]!), perHost)) {
          next = i;
          break;
        }
      }
      if (next < 0) {
        hostBlocked = queue.length > 0;
        break;
      }

      const url = queue.splice(next, 1)[0]!;
      const urlKey = urlDedupKey(url);
      visited.add(urlKey);
      launch(url, urlKey, depthOf.get(urlKey) ?? 0);
    }
    if (inFlight.size === 0) {
      // Every queued host is held by another crawl in this process: wait for a slot.
      if (hostBlocked) {
        await sleep(20);
        continue;
      }
      break;
    }
    await Promise.race(inFlight);
  }

  const budgetHit = collectedSoFar() >= maxPages || Date.now() >= deadline;
  return done(queue.length > 0 && budgetHit);
}


/**
 * Crawl many targets in parallel, returning one result per target in input order.
 *
 * This is the fast path across a fleet of sites: each site stays sequential
 * and polite, and the speed comes from running different origins together.
 * It is `crawlSite` in a bounded pool and shares its options, throttle and
 * host slots, so nothing here duplicates a rule.
 */
export async function crawlSites(
  crawler: Crawler,
  targets: CrawlTarget[],
  options: MultiSiteOptions = {},
): Promise<MultiSiteResult[]> {
  const width = Math.max(1, Math.floor(options.siteConcurrency ?? 4));
  const results: MultiSiteResult[] = new Array(targets.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const index = cursor++;
      const target = targets[index]!;
      results[index] = { target, result: await crawlSite(crawler, target, options) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, targets.length) }, worker));
  return results;
}
