// ─── Per-host stats for a site crawl ────────────────────────────────────────
//
// CRAWL-HOST-STATS-1: how each host behaved during one run: attempts, pages, failure classes, how
// often it refused the crawler, and its median latency.

import type { CrawlResult } from './core/types.js';
import type { HostStats } from './crawl-site-types.js';

type Tally = { attempts: number; pages: number; transient: number; structural: number; blocked: number; latencies: number[] };

/** The lowercase hostname of a URL, or an empty string when it does not parse. */
export function hostOf(candidate: string): string {
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function createHostStats() {
  const hostTally = new Map<string, Tally>();
  const tallyFor = (host: string) => {
    let entry = hostTally.get(host);
    if (!entry) {
      entry = { attempts: 0, pages: 0, transient: 0, structural: 0, blocked: 0, latencies: [] };
      hostTally.set(host, entry);
    }
    return entry;
  };
  return {
    /** Records one attempt against the host that was asked, so a redirect to www still counts against the origin. */
    record(host: string, attemptStartedAt: number, result: CrawlResult): void {
      const tally = tallyFor(host);
      tally.attempts++;
      tally.latencies.push(Date.now() - attemptStartedAt);
      if (result.ok) tally.pages += result.notModified ? 1 : result.pages.length;
      else {
        tally[result.failureClass === 'structural' ? 'structural' : 'transient']++;
        // 403 and 429 are the origin refusing a crawler; a policy refusal of ours never reached the origin.
        if (/\b(403|429)\b/.test(result.detail)) tally.blocked++;
      }
    },
    snapshot(): Record<string, HostStats> {
      return Object.fromEntries(
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
    },
  };
}
