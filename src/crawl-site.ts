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
import {
  DEFAULT_RECRAWL_MAX_INTERVAL_MS,
  DEFAULT_RECRAWL_MIN_INTERVAL_MS,
  createMemoryCrawlStore,
  isDue,
} from './crawl-store.js';
import type { CrawlState, CrawlStore, ScheduleEntry } from './crawl-store.js';
import { releaseHostSlot, sleep, tryAcquireHostSlot } from './core/host-throttle.js';
import { assertRequestUrlAllowed, assertTargetEligible } from './fetch/host-policy.js';
import { findNextPageUrl } from './extract/pagination-discovery.js';
import type { Crawler } from './index.js';
import { DEFAULT_MAX_PAGES } from './core/types.js';
import type { CrawlOptions, CrawlPage, CrawlTarget } from './core/types.js';
import type { CrawlProgress, HostStats, MultiSiteOptions, MultiSiteResult, SiteCrawlFailure, SiteCrawlOptions, SiteCrawlResult } from './crawl-site-types.js';

export type { CrawlProgress, HostStats, MultiSiteOptions, MultiSiteResult, SiteCrawlFailure, SiteCrawlOptions, SiteCrawlResult };


const DEFAULT_MAX_RETRIES = 1;

/**
 * A failure that retrying cannot fix. Retrying a blocked URL just burns the
 * budget to get the identical refusal — the origin implementation made the
 * same distinction with its TerminalCrawlError.
 */
function isTerminal(reason: string): boolean {
  return reason === 'blocked' || reason === 'quarantined' || reason === 'no_lane_available';
}



/**
 * Decide which URLs a run starts from, and record what the sitemap told us.
 *
 * Pulled out of `crawlSite` because it answers a question the main loop does
 * not care about: the loop consumes a queue, this decides what goes in it.
 * The three sources are mutually exclusive and ordered — a resume snapshot
 * replaces everything, an explicit list beats discovery, and the base URL is
 * the fallback.
 */
async function resolveSeeds(
  crawler: Crawler,
  target: CrawlTarget,
  options: SiteCrawlOptions,
  maxPages: number,
): Promise<{ seeds: string[]; lastmod: Record<string, string>; skippedByLastmod: string[]; fromSitemap?: boolean }> {
  const lastmod: Record<string, string> = {};
  const skippedByLastmod: string[] = [];

  // CRAWL-RESUME-1: a snapshot replaces the seeds entirely — its queue is
  // where the previous run stopped, and re-seeding from baseUrl on top would
  // re-walk ground already covered.
  if (options.resumeFrom) return { seeds: options.resumeFrom.queue, lastmod, skippedByLastmod };

  const explicit = options.seeds ?? target.seeds;
  if (explicit) return { seeds: explicit, lastmod, skippedByLastmod };

  if (!options.useSitemap) return { seeds: [target.baseUrl], lastmod, skippedByLastmod };

  // Free page discovery: the site's own sitemap beats guessing paths. Goes
  // through the crawler so it uses the SAME User-Agent and DNS resolver as
  // every other request — a discovery call that resolved DNS differently from
  // the crawl would be both inconsistent and, in tests, an unstubbed network
  // call.
  const entries = await crawler.discoverSeedEntries(target, maxPages);
  if (entries.length === 0) return { seeds: [target.baseUrl], lastmod, skippedByLastmod };

  for (const entry of entries) {
    if (entry.lastmod) lastmod[entry.url] = entry.lastmod;
  }

  // BETTER-LASTMOD-1: drop entries the sitemap says have not moved. The saving
  // is the FETCH itself, so this has to happen before seeding.
  const prior = options.priorLastmod;
  const fresh = prior
    ? entries.filter((entry) => {
        const unmoved = Boolean(entry.lastmod) && prior[entry.url] === entry.lastmod;
        if (unmoved) skippedByLastmod.push(entry.url);
        return !unmoved;
      })
    : entries;

  return { seeds: fresh.map((entry) => entry.url), lastmod, skippedByLastmod, fromSitemap: true };
}

/**
 * Crawl a whole site: seeds, discovery, budgets, dedup and resume.
 *
 * Takes a `Crawler` rather than a config so lane selection, budgeting and
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
  try {
    loaded = await store.load(storeKey);
  } catch {
    // A store that cannot be read is treated as empty: the crawl runs, it just starts from scratch.
  }
  const schedule: Record<string, ScheduleEntry> = { ...(loaded?.schedule ?? {}) };
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
  let saving: Promise<void> = Promise.resolve();
  let lastSavedAt = 0;
  const persist = (progress: CrawlProgress | null, final = false) => {
    // Without a store of its own, a run keeps nothing, and copying state for it would cost O(pages squared).
    if (!options.store) return;
    if (!final && Date.now() - lastSavedAt < (options.storeIntervalMs ?? 1000)) return;
    lastSavedAt = Date.now();
    // Chained, so snapshots reach the store in order, and a failing store cannot reach the crawl.
    const state: CrawlState = { progress, schedule: { ...schedule }, validators: { ...validators }, lastmod: { ...checkedLastmod } };
    saving = saving.then(() => store.save(storeKey, state)).catch(() => {});
  };
  // Only a URL that was actually checked keeps its date, so a page that failed this run is not skipped on the next.
  const checkedLastmod: Record<string, string> = { ...(loaded?.lastmod ?? {}) };
  // A page that redirected is recorded under the URL that was listed as well as the one it ended on, so the
  // sitemap date and the schedule are found again next run.
  const touch = (key: string, unchangedNow: boolean, requested = key) => {
    for (const name of new Set([key, requested])) {
      if (lastmod[name]) checkedLastmod[name] = lastmod[name];
      schedule[name] = {
        checkedAt: Date.now(),
        unchangedStreak: unchangedNow ? (schedule[name]?.unchangedStreak ?? 0) + 1 : 0,
      };
    }
  };

  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);

  const pages: CrawlPage[] = [];
  const notModified: string[] = [];
  const failures: SiteCrawlFailure[] = [];
  const validators: SiteCrawlResult['validators'] = {};
  const unchanged: string[] = [];
  const lastmod: Record<string, string> = {};
  const skippedByLastmod: string[] = [];
  const duplicates: SiteCrawlResult['duplicates'] = [];
  const nearDuplicates = createNearDuplicateIndex(options.nearDuplicateDistance ?? 3);
  const hostTally = new Map<string, { attempts: number; pages: number; transient: number; structural: number; blocked: number; latencies: number[] }>();
  const tallyFor = (host: string) => {
    let entry = hostTally.get(host);
    if (!entry) {
      entry = { attempts: 0, pages: 0, transient: 0, structural: 0, blocked: 0, latencies: [] };
      hostTally.set(host, entry);
    }
    return entry;
  };
  const hostStats = (): Record<string, HostStats> =>
    Object.fromEntries(
      [...hostTally].map(([host, e]) => {
        const sorted = [...e.latencies].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length === 0 ? 0 : sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
        return [
          host,
          {
            attempts: e.attempts,
            pages: e.pages,
            failures: { transient: e.transient, structural: e.structural },
            blockRate: e.attempts === 0 ? 0 : e.blocked / e.attempts,
            medianLatencyMs: median,
          },
        ];
      }),
    );

  const done = async (truncated: boolean): Promise<SiteCrawlResult> => {
    // A finished run clears its snapshot, and a truncated one keeps it so the next run continues.
    persist(truncated ? lastProgress : null, true);
    await saving;
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
      duplicates,
      hosts: hostStats(),
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
  // once, and report it as a single failure rather than N identical ones.
  try {
    assertTargetEligible(target);
  } catch (error) {
    failures.push({
      url: target.baseUrl,
      reason: 'blocked',
      detail: error instanceof Error ? error.message : String(error),
    });
    return done(false);
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

  const shouldSkip = (candidate: string) => {
    if ((options.excludePatterns ?? []).some((pattern) => pattern.test(candidate))) return true;
    const include = options.includePatterns;
    // Allowlist, when given: anything not named is not followed.
    return Boolean(include?.length) && !include!.some((pattern) => pattern.test(candidate));
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
  const hostOf = (candidate: string): string => {
    try {
      return new URL(candidate).hostname.toLowerCase();
    } catch {
      return '';
    }
  };
  const collectedSoFar = () => alreadyCollected + pages.length + notModified.length;

  const processUrl = async (url: string, urlKey: string, depth: number): Promise<void> => {
    const prior = options.priorValidators?.[url];
    const perPageOptions: CrawlOptions = {
      ...options,
      etag: prior?.etag ?? options.etag ?? null,
      lastModified: prior?.lastModified ?? options.lastModified ?? null,
      // Pagination discovery reads markup, so the page must carry its HTML.
      // Requested here rather than left to the caller: otherwise
      // followPagination would silently do nothing.
      includeHtml: options.includeHtml || options.followPagination === true || options.followLinks === true,
      // This loop does its own retrying; letting crawl() retry too would
      // multiply attempts (3 x 3 = 9 requests for one page).
      retries: 0,
    };

    let lastFailure: SiteCrawlFailure | null = null;
    let succeeded = false;

    for (let attempt = 0; attempt <= maxRetries && !succeeded; attempt++) {
      const attemptStarted = Date.now();
      const result = await crawler.crawl(target, url, perPageOptions);
      // CRAWL-HOST-STATS-1: the request's own host, so a redirect to www still counts against the origin asked.
      const tally = tallyFor(hostOf(url));
      tally.attempts++;
      tally.latencies.push(Date.now() - attemptStarted);
      if (result.ok) tally.pages += result.notModified ? 1 : result.pages.length;
      else {
        tally[result.failureClass === 'structural' ? 'structural' : 'transient']++;
        // 403 and 429 are the origin refusing a crawler; a policy refusal of ours never reached the origin.
        if (/\b(403|429)\b/.test(result.detail)) tally.blocked++;
      }

      if (result.ok) {
        succeeded = true;
        if (result.notModified) {
          notModified.push(url);
          touch(url, true);
          // The stored validators are still current — carry them forward so
          // the consumer's next run keeps getting free 304s.
          if (prior?.etag || prior?.lastModified) {
            validators[url] = {
              etag: prior.etag ?? null,
              lastModified: prior.lastModified ?? null,
              bodySha256: '',
              contentRegionSha256: prior.contentRegionSha256 ?? '',
              textSha256: prior.textSha256 ?? '',
            };
          }
          break;
        }
        // CRAWL-DEDUP-1 (found in a live run): dedup keyed only on the
        // REQUESTED url, so two different URLs that redirect to the same
        // page were both crawled and both stored — a real site's
        // /home, /index and / commonly converge. Mark the RESOLVED url
        // visited too, and drop a page already collected under it.
        const fresh = result.pages.filter((p) => {
          const key = urlDedupKey(p.url);
          if (visited.has(key) && key !== urlKey) return false;
          visited.add(key);
          return true;
        });
        // CRAWL-NEARDUP-1: the same content under another URL is reported, not returned again. Its
        // links and validators are still used below, since the page itself was read.
        for (const p of fresh) {
          const twin = nearDuplicates.check(p.url, p.contentSimhash);
          if (twin) duplicates.push({ url: p.url, of: twin.of, distance: twin.distance });
          else pages.push(p);
        }
        for (const p of fresh) {
          // CRAWL-UNCHANGED-1: these hashes were computed on every page and
          // then thrown away. Comparing against last run is what makes
          // re-crawls cheap for origins that send NO ETag (most small sites):
          // the page had to be fetched, but extraction/LLM need not re-run.
          //
          // CRAWL-HASH-1: compare LIKE WITH LIKE. contentRegionSha256 is
          // structural (HTML-only) and is the better signal, but it is empty
          // on text-only rungs — comparing it across a rung change would
          // report a false content change. Prefer it only when both sides
          // have it; otherwise fall back to the always-present text hash.
          const prev = options.priorValidators?.[p.url];
          const bothStructural = Boolean(prev?.contentRegionSha256 && p.contentRegionSha256);
          const same = bothStructural
            ? prev!.contentRegionSha256 === p.contentRegionSha256
            : Boolean(prev?.textSha256 && prev.textSha256 === p.textSha256);
          if (same) unchanged.push(p.url);
          touch(p.url, same, url);
          validators[p.url] = {
            etag: p.httpEtag,
            lastModified: p.httpLastModified,
            bodySha256: p.bodySha256,
            contentRegionSha256: p.contentRegionSha256,
            textSha256: p.textSha256,
          };
        }

        // Discovery from the page just read — appends only, so breadth-first
        // ordering of what was already scheduled is preserved.
        const first = fresh[0];

        // Pagination stays at the SAME depth: page 2 of a listing is the same
        // distance from the seed as page 1, not one hop further.
        if (options.followPagination && first?.html) {
          const next = findNextPageUrl(first.html, url);
          if (next) enqueue(next, depth);
        }

        // Whole-site discovery: every same-site link, one hop deeper.
        if (options.followLinks && first) {
          for (const link of first.links) enqueue(link.url, depth + 1);
        }
        break;
      }

      lastFailure = { url, reason: result.reason, detail: result.detail };
      // Retrying these produces the identical answer; spend the budget elsewhere.
      if (isTerminal(result.reason) || result.failureClass === 'structural') break;
      if (attempt < maxRetries) {
        // CRAWL-BACKOFF-1: when the origin SAID how long to wait (429/503 +
        // Retry-After), wait that long. Our own schedule is a guess; theirs
        // is an instruction, and ignoring it is what gets a crawler banned.
        const ourBackoff = (options.retryBackoffMs ?? 500) * (attempt + 1);
        await sleep(Math.max(result.retryAfterMs ?? 0, ourBackoff));
      }
    }

    if (!succeeded && lastFailure) failures.push(lastFailure);
  };

  const inFlight = new Set<Promise<void>>();

  const launch = (url: string, urlKey: string, depth: number) => {
    const host = hostOf(url);
    running.set(urlKey, url);
    const task = processUrl(url, urlKey, depth)
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
        lastProgress = {
          queue: [...running.values(), ...queue],
          visited: [...visited].filter((key) => !running.has(key)),
          depths: Object.fromEntries(depthOf),
          collected: collectedSoFar(),
        };
        persist(lastProgress);
        options.onProgress?.(lastProgress);
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
      if (collectedSoFar() + running.size >= maxPages) break;
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
