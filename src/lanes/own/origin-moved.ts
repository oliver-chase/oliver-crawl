// ─── Origin-moved detection ─────────────────────────────────────────────────
//
// Did the direct rung refuse because the origin moved to a different site, and flagging a result that a later rung served.

import type { CrawlResult } from '../../core/types.js';

/**
 * The registrable part of a host: the last two labels, or the last three under a two-letter country
 * code with a generic second level (shop.co.uk is a different site from other.co.uk). A short list
 * stands in for the public suffix list.
 */
function registrableHost(host: string): string {
  const labels = host.toLowerCase().split('.');
  const generic = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);
  const take = labels.length >= 3 && labels[labels.length - 1]!.length === 2 && generic.has(labels[labels.length - 2]!) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** Test seam. */
export const __isOffDomainRefusalForTests = (detail: string, requestedUrl: string): boolean => isOffDomainRefusal(detail, requestedUrl);

/**
 * Did the direct rung refuse because the origin moved to a DIFFERENT SITE?
 *
 * Decided from the URL in the refusal, not from how the guard worded it. The
 * first version matched `Blocked off-domain ... URL`, and the guard checks
 * https and credentials BEFORE off-domain — so a redirect to plain http is
 * refused as "non-https" and the word never appears. Parked domains routinely
 * 301 to http, which is the case this exists for.
 *
 * Registrable-domain comparison, so `site.com` -> `events.site.com` is NOT a
 * move: same publisher, and flagging it adds review load for a non-event.
 *
 * Tested through the ladder in `tests/lanes/origin-moved.test.ts`, not against
 * a restatement of the rule — an earlier version asserted a duplicated copy of
 * the regex, so rewriting the detector left it green.
 */
export function isOffDomainRefusal(detail: string, requestedUrl: string): boolean {
  const found = detail.match(/https?:\/\/[^\s)]+/);
  if (!found) return false;
  try {
    return registrableHost(new URL(found[0]).hostname) !== registrableHost(new URL(requestedUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Attach ORIGIN-MOVED-1 to any rung that served a page past an off-domain
 * refusal — not just Jina.
 *
 * The first version wrapped the Jina branch only, and `renderFallback` runs
 * BEFORE it: on any deployment with `browserRender` configured, the render rung
 * won and the flag was unreachable. The archive rung had the same gap. The
 * signal has to live where the ladder decides, not on one branch of it.
 */
export function withOriginMoved(result: CrawlResult, priorDetail: string, servedBy: string, requestedUrl: string): CrawlResult {
  if (!result.ok || result.notModified) return result;
  if (!isOffDomainRefusal(priorDetail, requestedUrl)) return result;
  return { ...result, originMoved: { refusal: priorDetail, servedBy } };
}
