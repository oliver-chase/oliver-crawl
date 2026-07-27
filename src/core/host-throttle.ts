// ─── Per-host throttle ──────────────────────────────────────────────────────
//
// Politeness that actually holds across a whole process, not just within one
// crawl run.
//
// crawlSite is sequential and can pause between pages, but that only governs
// ONE run. Crawl fifty targets that happen to share a host — a city's venues
// all on the same CMS, or several targets behind one CDN — and nothing
// stopped fifty simultaneous requests hitting that origin. That is how a
// crawler earns a block, and the origin has no way to tell it apart from an
// attack.
//
// This enforces a minimum gap between requests to the SAME host, process-wide
// and across concurrent callers. Different hosts never wait on each other.
//
// Off by default (0 ms): the own lane's politeness has to be a deliberate,
// visible setting rather than a hidden latency tax a consumer can't find.

/** Serialised "next allowed time" per host. */
const NEXT_ALLOWED_AT = new Map<string, number>();

/**
 * Rolling average response latency per host, for adaptive throttling.
 *
 * Borrowed in SPIRIT from Scrapy's AutoThrottle (not its code or its
 * formula): a fixed delay is the wrong tool because it is either too slow
 * for a CDN-backed site or too fast for a struggling one. Latency is the
 * origin telling you how much load it is under — a server that took 4s to
 * answer should not be asked again in 200ms.
 *
 * Deliberately simpler than Scrapy's: one exponential moving average per
 * host and a multiplier, no concurrency-slot machinery, because this
 * crawler is sequential per run and does not need to solve that problem.
 */
const AVG_LATENCY_MS = new Map<string, number>();

/** Weight of the newest sample. 0.3 = responsive to a change without one
 *  slow outlier dominating. */
const LATENCY_SMOOTHING = 0.3;

/** Test seam. */
export function __clearThrottleForTests(): void {
  NEXT_ALLOWED_AT.clear();
  AVG_LATENCY_MS.clear();
}

/** Record how long a host took to answer, for adaptive pacing. */
export function recordHostLatency(hostname: string, latencyMs: number): void {
  const host = hostname.toLowerCase();
  const prior = AVG_LATENCY_MS.get(host);
  AVG_LATENCY_MS.set(host, prior === undefined ? latencyMs : prior * (1 - LATENCY_SMOOTHING) + latencyMs * LATENCY_SMOOTHING);
}

/**
 * The gap to leave before the next request to this host.
 *
 * With adaptive pacing on, that is `avgLatency x multiplier` — a site that
 * answers in 100ms is polled briskly, one grinding at 3s is given room —
 * with the configured minimum as a floor so adaptive can only ever make the
 * crawler MORE polite, never less.
 */
export function intervalForHost(hostname: string, minIntervalMs: number, adaptiveMultiplier = 0): number {
  if (adaptiveMultiplier <= 0) return minIntervalMs;
  const avg = AVG_LATENCY_MS.get(hostname.toLowerCase());
  if (avg === undefined) return minIntervalMs;
  return Math.max(minIntervalMs, Math.round(avg * adaptiveMultiplier));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until this host is allowed another request, then reserve the next slot.
 *
 * The reservation is made BEFORE awaiting, so concurrent callers for the same
 * host queue behind each other instead of all reading the same "now" and
 * firing together — the bug a naive last-request-time check has.
 */
export async function throttleHost(hostname: string, minIntervalMs: number, adaptiveMultiplier = 0): Promise<void> {
  const interval = intervalForHost(hostname, minIntervalMs, adaptiveMultiplier);
  if (!interval || interval <= 0) return;

  const host = hostname.toLowerCase();
  const now = Date.now();
  const earliest = NEXT_ALLOWED_AT.get(host) ?? 0;
  const runAt = Math.max(now, earliest);

  // Reserve first — this is what makes concurrent callers serialise.
  NEXT_ALLOWED_AT.set(host, runAt + interval);

  const waitMs = runAt - now;
  if (waitMs > 0) await sleep(waitMs);
}
