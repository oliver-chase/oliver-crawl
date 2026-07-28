// ─── Remember which rung actually works for a host ──────────────────────────
//
// BETTER-RUNGMEMORY-1: every crawl walked the ladder from the
// top. A host that always 403s the direct fetch and always succeeds on the
// render rung therefore cost a guaranteed wasted request on every page,
// forever — and on a 200-page site that is 200 requests spent proving
// something we already learned on page one.
//
// Two rules keep it honest:
//
//   1. A remembered rung is a STARTING POINT, never a restriction. The full
//      ladder stays available beneath it, so a wrong memory costs one
//      request, not a failed crawl.
//   2. Memory expires. A site that stops blocking must not stay pinned to
//      the expensive rung forever, and blocking is frequently temporary.

/** How long a remembered rung is trusted before the ladder is re-probed. */
export const RUNG_MEMORY_TTL_MS = 30 * 60 * 1000; // 30 minutes

type Remembered = { rung: string; expiresAt: number };

/**
 * The store is created PER CRAWLER, never module-level.
 *
 * This is the same lesson as HOST-CACHE-SCOPE-1: a module-level Map shared by
 * every crawler in the process leaks one crawler's observations into another's
 * decisions. It is not merely a test-isolation nuisance — a different
 * User-Agent genuinely gets different answers from the same host, so a memory
 * learned under one identity is not evidence about another.
 */
export type RungMemory = Map<string, Remembered>;

export function createRungMemory(): RungMemory {
  return new Map();
}

/**
 * Record the rung that actually produced a page for this host.
 *
 * Only ever called on SUCCESS. Remembering failures would be the same trap
 * the robots cache had: one bad minute pinning a host into a worse path than
 * it needs.
 */
export function rememberWinningRung(memory: RungMemory, hostname: string, rung: string): void {
  memory.set(hostname.toLowerCase(), { rung, expiresAt: Date.now() + RUNG_MEMORY_TTL_MS });
}

/**
 * The rung that worked last time for this host, if the memory is still fresh.
 *
 * Returns null when nothing is remembered or it has expired — in which case
 * the caller simply starts at the top of the ladder as it always did.
 */
export function recallWinningRung(memory: RungMemory, hostname: string): string | null {
  const host = hostname.toLowerCase();
  const hit = memory.get(host);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    memory.delete(host);
    return null;
  }
  return hit.rung;
}

/**
 * Drop a host's memory after the remembered rung failed.
 *
 * A remembered rung that stops working usually means the host CHANGED, so the
 * path we have been skipping may now be the one that works. A stale memory
 * turns this optimisation into a way to lose pages.
 */
export function forgetWinningRung(memory: RungMemory, hostname: string): void {
  memory.delete(hostname.toLowerCase());
}

/**
 * Should the direct fetch be skipped for this host?
 *
 * True only when a live memory says a LATER rung is what works. Deliberately
 * narrow — it reports that the cheap rung is known-useless here, and does not
 * try to select a rung.
 *
 * A caller that skips the fetch still has every recovery rung available, and
 * on failure must call `forgetWinningRung` and retry the normal path — that
 * pairing is what keeps a stale memory to one extra request rather than a
 * lost page.
 */
export function shouldSkipDirectFetch(memory: RungMemory, hostname: string): boolean {
  const remembered = recallWinningRung(memory, hostname);
  return remembered !== null && remembered !== 'fetch';
}
