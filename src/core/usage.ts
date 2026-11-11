// ─── Usage emission ─────────────────────────────────────────────────────────
//
// One home for the "report this call, but never let reporting break a crawl"
// rule. Previously duplicated verbatim in three modules (own lane, vendor
// lane, search) — three copies of a try/catch is three chances for one of
// them to drift into throwing.

import type { ResolvedConfig } from './config.js';
import type { UsageEvent } from './types.js';

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Fire-and-forget. A consumer's sink is not trusted to be fast or total. */
export function emitUsage(config: ResolvedConfig, event: UsageEvent): void {
  try {
    config.onUsage?.(event.host || !event.url ? event : { ...event, host: hostnameOf(event.url) });
  } catch {
    // deliberately swallowed — telemetry must never fail the operation
  }
}
