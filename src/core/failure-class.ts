// ─── Is this failure worth retrying? ────────────────────────────────────────
//
// CRAWL-DEGRADE-1: the package reported per-crawl outcomes and
// left every consumer to re-invent the same triage from raw `reason` strings
// and prose `detail` text — and to get it wrong, because the interesting
// distinction is not in `reason` at all.
//
// `unreachable` covers both a DNS blip that will be gone in a minute and a
// domain that no longer exists. `empty` covers both a 404 and a page that
// happened to render nothing today. A consumer deciding "retry tonight" vs
// "tell a human this source is dead" needs those separated, and only this
// package has the context to judge it.
//
// One bit, deliberately:
//
//   transient  — the world might differ next time. Retry on your schedule.
//   structural — retrying changes nothing until something is fixed. A human,
//                or a config change, is required.
//
// A consumer counting consecutive `structural` failures per source has what
// it needs to disable a dead one automatically; counting `transient` ones
// tells it nothing except that the internet is the internet.

import type { CrawlFailureReason } from './types.js';

export type FailureClass = 'transient' | 'structural';

/**
 * HTTP statuses that mean "this request will fail identically forever" —
 * as opposed to 429/5xx, which are the server having a bad day.
 *
 * 403 is deliberately TRANSIENT: it is overwhelmingly a bot wall rather than
 * a permanent refusal, and those relent (different rung, different time,
 * different headers). Treating it as structural would retire sources that
 * would have worked on the very next run.
 */
const STRUCTURAL_STATUS = /\b(400|401|404|410|451)\b/;

/**
 * Classify a failed crawl.
 *
 * `detail` is inspected only for an HTTP status, never parsed as prose — the
 * wording of these messages changes, the numbers do not.
 */
export function classifyFailure(reason: CrawlFailureReason, detail: string): FailureClass {
  switch (reason) {
    // A policy refusal is a decision we already made. It will be re-made
    // identically until the TARGET or the config changes.
    case 'blocked':
    case 'quarantined':
    case 'no_lane_available':
      return 'structural';

    case 'unreachable':
      // A 404/410 reached us — the server answered, the page is gone.
      // Anything else here is transport: DNS, TLS, timeouts, resets.
      return STRUCTURAL_STATUS.test(detail) ? 'structural' : 'transient';

    case 'empty':
      // An unsupported content-type will be unsupported forever; a page that
      // rendered nothing may well render something tomorrow.
      //
      // Two more that look transient and are not:
      //   - a missing optional parser (CRAWL-PDF-1). Retrying changes nothing
      //     until someone installs the package, so it belongs with the
      //     failures a human has to act on rather than the ones to wait out.
      //   - a PDF with no text layer. A scanned document does not acquire one
      //     by being fetched again; it needs a vision model.
      return /Unsupported content-type/i.test(detail) ||
        /needs the optional .* package/i.test(detail) ||
        /no text layer/i.test(detail) ||
        STRUCTURAL_STATUS.test(detail)
        ? 'structural'
        : 'transient';

    default:
      // An unrecognised reason is treated as transient on purpose: the cost
      // of a needless retry is one request, while wrongly retiring a live
      // source is silent data loss.
      return 'transient';
  }
}
