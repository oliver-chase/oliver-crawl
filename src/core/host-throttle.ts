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

/** Test seam. */
export function __clearThrottleForTests(): void {
  NEXT_ALLOWED_AT.clear();
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
export async function throttleHost(hostname: string, minIntervalMs: number): Promise<void> {
  if (!minIntervalMs || minIntervalMs <= 0) return;

  const host = hostname.toLowerCase();
  const now = Date.now();
  const earliest = NEXT_ALLOWED_AT.get(host) ?? 0;
  const runAt = Math.max(now, earliest);

  // Reserve first — this is what makes concurrent callers serialise.
  NEXT_ALLOWED_AT.set(host, runAt + minIntervalMs);

  const waitMs = runAt - now;
  if (waitMs > 0) await sleep(waitMs);
}
