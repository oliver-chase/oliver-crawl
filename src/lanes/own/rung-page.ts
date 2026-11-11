// ─── Building a page and refusing a quarantine, for every rung ──────────────
//
// Every rung of the own lane turns a body into a page the same way and refuses a quarantined page the same
// way. These two helpers hold that once.

import { buildPage } from '../../fetch/build-page.js';
import type { QuarantineEvidence } from '../../fetch/build-page.js';
import { emitUsage } from '../../core/usage.js';
import type { ResolvedConfig } from '../../core/config.js';
import type { CrawlOptions, CrawlResult } from '../../core/types.js';

/** buildPage with the limits, text cap and html option taken from the crawl's config and options. */
export function buildRungPage(
  config: ResolvedConfig,
  options: CrawlOptions,
  input: {
    url: string;
    html: string;
    contentType: string;
    etag: string | null;
    lastModified: string | null;
    baseHost: string;
    rung: string;
    /** Set when the caller already resolved the cap. */
    maxTextChars?: number;
  },
) {
  return buildPage({
    ...input,
    maxTextChars: input.maxTextChars ?? options.maxTextChars ?? config.defaults.maxTextChars,
    includeHtml: options.includeHtml ?? false,
    maxLinks: config.limits.maxLinksPerPage,
    maxOutboundHosts: config.limits.maxOutboundHosts,
  });
}

/**
 * QUARANTINE-TELEMETRY-1 and QUARANTINE-EVIDENCE-1: a rung that quarantines a page reports it, and the
 * refusal carries what tripped the guard so a consumer that must not lose a page can raise a review task.
 */
export function quarantined(
  config: ResolvedConfig,
  url: string,
  started: number,
  detail: string,
  page: QuarantineEvidence,
): CrawlResult {
  emitUsage(config, { lane: 'own', rung: 'guard', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
  return {
    ok: false,
    reason: 'quarantined',
    detail,
    lane: 'own',
    quarantine: { signals: page.signals, text: page.text, title: page.title },
  };
}
