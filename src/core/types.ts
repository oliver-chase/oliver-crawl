import type { PromptInjectionSignal } from '../guard/prompt-injection-guard.js';
import type { BrowserAction } from '../fetch/local-render.js';
import type { ContentImage } from '../extract/content-images.js';
import type { FailureClass } from './failure-class.js';
import type { StructuredSummary } from '../extract/structured-summary.js';
// ─── Core contract ──────────────────────────────────────────────────────────
//
// Everything in this package is built against these types. Three rules govern
// them, and they are why the package is reusable at all:
//
//   1. NO DATABASE. Nothing here imports a DB client. State that a consumer
//      wants persisted (usage, cost, learned recipes) leaves through injected
//      callbacks, so one consumer can write Supabase, another a Sheet, and a
//      forked user can write nothing at all.
//   2. NO ENV READS IN CORE. Config is passed in explicitly. `configFromEnv()`
//      (src/core/config.ts) is a separate, optional convenience — a consumer
//      can hold two differently-configured crawlers in one process, which an
//      env-reading core makes impossible.
//   3. FAIL SOFT ACROSS THE BOUNDARY. A crawl returns a result describing what
//      happened; it does not throw for ordinary failure (blocked, unreachable,
//      empty). Programmer error still throws.

/** Which lane(s) a crawl may use. See docs/LANES.md. */
export type LaneName = 'own' | 'vendor';

/**
 * A crawl target. Deliberately minimal and NOT any consumer's database row —
 * a consumer's own source registry may have many fields, none of which this package
 * needs. A consumer adapts its record into this shape at the boundary.
 */
export type CrawlTarget = {
  /** Canonical https origin the crawl is scoped to. Same-site enforcement is
   *  measured against this (apex/www variance allowed, nothing else). */
  baseUrl: string;
  /** Human label, used only in error messages and logs. */
  name?: string;
  /** Robots posture the CONSUMER has already decided for this target. The
   *  package enforces it; it does not overrule it. 'unknown' is treated as
   *  not-allowed by the default policy — fail closed.
   *
   *  Leave it UNSET (or 'unknown') and turn on `autoRobots` to have the
   *  crawler fetch and evaluate robots.txt itself instead of trusting your
   *  bookkeeping — see CrawlConfig.autoRobots. */
  robotsPolicy?: 'allow' | 'disallow' | 'conditional' | 'unknown';
  /** Consumer-defined eligibility flag. False short-circuits every fetch. */
  active?: boolean;
  /** Optional extra same-site seed paths to crawl beyond baseUrl. */
  seeds?: string[];
  /**
   * Extra request headers for THIS target only — an API key, a bearer token,
   * a session cookie for a members area you legitimately have access to.
   *
   * This is what makes "it cannot read anything behind a login" a limitation
   * you can lift yourself rather than a wall. You supply credentials you
   * already hold; the package never acquires, stores or refreshes them.
   *
   * Sent ONLY to this target's own host. The same-site rule already refuses
   * off-domain URLs, so a redirect cannot walk your token to another origin —
   * which is the mistake this feature would otherwise invite.
   *
   * Never set `host`, `content-length` or `user-agent` here; the crawler owns
   * those and will ignore attempts to override them.
   */
  headers?: Record<string, string>;
};

/** Per-request options that don't belong to the target itself. */
export type CrawlOptions = {
  /** Lane order to attempt. Defaults to ['own'] — the free lane only, so a
   *  consumer never pays a vendor without asking. */
  lanes?: LaneName[];
  /** Ceiling on extracted text per page, in characters (every limit downstream is in chars). A page that hit
   *  it ends with a short "[TRUNCATED]" marker beyond the ceiling and reports `truncated: true`. */
  maxTextChars?: number;
  /** Per-request timeout for a single fetch. */
  timeoutMs?: number;
  /** Max pages to visit in one crawl (seeds + discovered links). */
  maxPages?: number;
  /** Return the raw HTML alongside the sanitised text. Off by default: `text`
   *  is what is safe to feed an LLM, and shipping full HTML on every page is
   *  pure payload weight for callers that never read it. Needed by anything
   *  that must inspect markup itself — pagination discovery, recipe replay. */
  includeHtml?: boolean;
  /** Conditional-GET validators from a previous crawl of the same URL. When
   *  the origin answers 304, the crawl reports `notModified` and costs
   *  nothing further. */
  etag?: string | null;
  lastModified?: string | null;
  /**
   * Retry attempts for a transient failure (network, 5xx). Default 0 — one
   * attempt, no retry. Policy refusals are never retried at any setting,
   * because the answer cannot change.
   *
   * crawlSite does its OWN retrying and passes 0 here deliberately: two
   * retry layers multiply (3 x 3 = 9 requests for one page), which is how a
   * polite crawler accidentally becomes a hammer.
   */
  retries?: number;
};

/** What a single fetched page yielded. */
export type CrawlPage = {
  url: string;
  /** Cleaned, sanitised, length-capped visible text. Never raw HTML. */
  text: string;
  /**
   * The main content region as Markdown — headings, lists, tables and links
   * preserved, page chrome (nav/header/footer/aside) removed.
   *
   * VENDOR-PARITY-1: prefer this over `text` when feeding an LLM. Plain text
   * flattens a schedule table into an unlabelled token soup; markdown keeps
   * the structure the page's author already encoded, which is the difference
   * between an extractor guessing and reading.
   *
   * Empty string on text-only rungs (Jina, vendor markdown) where there is no
   * HTML to convert — those rungs already deliver prose. Always check `text`
   * as the fallback.
   */
  markdown: string;
  /**
   * What KIND of document this is (CRAWL-FEED-1).
   *
   * `'html'` is the common case and everything else is a data document
   * delivered verbatim in `text` — parsing an ICS feed into events, or a CSV
   * into rows, is domain logic and stays with the caller. Branch on this
   * rather than sniffing `contentType`, which varies by server.
   *
   * Non-HTML kinds have no `markdown`, `links`, `jsonLd` or
   * `contentRegionSha256`: there is no HTML to derive them from.
   */
  contentKind: ContentKind;
  /**
   * BETTER-SOFT404-1: the page loaded fine but appears to say nothing —
   * "No events scheduled at this time", a parked domain, an under-
   * construction placeholder.
   *
   * Advisory ONLY. The page is still returned in full; this just lets you
   * skip paying a model to read it. Note that an off-season venue really IS
   * "no events scheduled", and that is a true fact you may want to record
   * rather than discard — so this informs a decision, it never makes one.
   */
  likelyEmptyState: boolean;
  /**
   * CRAWL-VISION-1: images that plausibly carry this page's real content —
   * the poster or flyer some venue and municipal pages publish INSTEAD of
   * text, ranked best-first and usually empty.
   *
   * Finding them is free and ours; reading them needs a vision model and is
   * yours. A page with little text but a candidate image here is not empty —
   * it is a page whose content you have not paid to read yet.
   */
  candidateContentImages: ContentImage[];
  /**
   * CRAWL-CONTENTKIND-1: which version of this package's extraction produced
   * the page. Bumped whenever text/markdown/link/JSON-LD extraction changes.
   *
   * Store it beside the page. When the stored value is behind
   * `EXTRACTOR_VERSION`, re-process — otherwise an extractor improvement only
   * ever applies to pages crawled after it shipped, and there is no way to
   * add this retroactively with any value.
   */
  extractorVersion: string;
  /**
   * GUARD-TELEMETRY-1: what the guard did to this page, as distinct from
   * whether it refused it.
   *
   * The sanitiser already computes both and they were discarded before the
   * page was built. A consumer storing crawl provenance wants them: a page
   * that was capped is a page whose tail was never seen, and a redaction count
   * above zero means the text differs from what the origin served — both
   * change how much you should trust a downstream extraction, and neither is
   * recoverable afterwards.
   *
   * `truncated` means the text hit maxTextChars, not that anything failed.
   */
  redactionCount: number;
  truncated: boolean;
  title: string | null;
  /** Raw HTML, only when the caller asked for it (`includeHtml`). Callers
   *  that feed an LLM should use `text` — it has been through the guard. */
  html?: string;
  contentType: string;
  /** Hash of the raw body exactly as received. Moves on ANY byte change,
   *  including a nav tweak or a rotating CSRF token — rarely the signal you
   *  want on its own. */
  bodySha256: string;
  /**
   * Nav/footer/script-INSENSITIVE structural hash of the HTML. The best
   * "did the real content change" signal — but only computable from HTML,
   * so it is EMPTY STRING on text-only rungs (Jina, vendor markdown).
   *
   * CRAWL-HASH-1: it used to be filled on those rungs with a hash of the
   * extracted text instead, which silently made it non-comparable with the
   * HTML-derived value — a page fetched normally one run and via Jina the
   * next would report a false content change. Empty is honest; compare
   * `textSha256` when this is absent on either side.
   */
  contentRegionSha256: string;
  /** Hash of the delivered sanitised text. ALWAYS set, on every rung, so it
   *  is the universally comparable change signal — at the cost of moving
   *  when nav text changes. Use as the fallback when contentRegionSha256 is
   *  unavailable. */
  textSha256: string;
  /**
   * CRAWL-NEARDUP-1: a 64-bit SimHash of the delivered text, as 16 hex characters. Pages whose
   * hashes differ by a few bits carry the same content. Empty when the page has under 60 words,
   * because a short page shares too much template text to compare.
   */
  contentSimhash: string;
  httpEtag: string | null;
  httpLastModified: string | null;
  /** Structured data found on the page, if any — the free, deterministic
   *  extraction path that needs no LLM. */
  jsonLd: unknown[];
  /**
   * What that structured data actually IS (JSONLD-SIGNAL-1).
   *
   * `jsonLd.length > 0` is a misleading test: most JSON-LD in the wild is site
   * furniture (WebSite, Organization, BreadcrumbList) that says nothing about
   * the page's subject. Check `structuredData.hasContentData` instead — false
   * means a model is the only way to get anything off this page, true means
   * read the structured data first, because it is free and exact.
   */
  structuredData: StructuredSummary;
  /** Distinct off-site https hosts linked from this page (capped). */
  outboundHosts: string[];
  /** Same-site links found, for pagination/detail-page following. */
  links: PageLink[];
  /** Which lane actually produced this page. */
  lane: LaneName;
  /** Which rung within the lane (e.g. 'fetch', 'jina', 'firecrawl'). */
  rung: string;
};

export type PageLink = { url: string; text: string };

/**
 * Document kinds the own lane will fetch.
 *
 * `'calendar'` (ICS) matters most: a structured feed is more accurate and more stable than scraping a
 * page, so the fetch rung reads it (CRAWL-FEED-1).
 */
export type ContentKind = 'html' | 'calendar' | 'csv' | 'json' | 'feed' | 'text' | 'pdf';

export type { BrowserAction } from '../fetch/local-render.js';

export type { ContentImage } from '../extract/content-images.js';

export type { FailureClass } from './failure-class.js';

export type { StructuredSummary } from '../extract/structured-summary.js';

/** The result of a crawl. Ordinary failure is a value, not an exception. */
export type CrawlResult =
  | {
      ok: true;
      pages: CrawlPage[];
      notModified?: false;
      /**
       * ORIGIN-MOVED-1: the direct fetch was REFUSED on policy grounds and a
       * fallback rung served the page anyway.
       *
       * Example: a domain is sold and now
       * redirects to an unrelated business. The direct
       * rung refuses the off-domain redirect; Jina then follows the
       * same redirect from its own IPs and returns the new owner's content, and
       * the crawl would report `ok: true` with no indication that the page belongs
       * to a different business.
       *
       * Refusing outright is the wrong fix. An off-domain redirect is routinely
       * a genuine migration, so
       * the fallback still runs — but the refusal it stepped past travels with
       * the result, so a consumer can hold the page for review before
       * publishing content for a site that has changed hands.
       *
       * Absent on an ordinary crawl. Its presence IS the signal.
       */
      originMoved?: { refusal: string; servedBy: string };
    }
  | { ok: true; pages: []; notModified: true }
  | {
      ok: false;
      reason: CrawlFailureReason;
      detail: string;
      lane?: LaneName;
      /**
       * BODY-RECEIVED-1: did an origin actually answer, or did we never get a
       * page at all?
       *
       * `unreachable` covers both "the site is down" and "the site served a
       * JavaScript shell with no readable text", because from the ladder's side
       * both end with no content from anywhere. Those are different facts for a
       * consumer: the first is worth retrying, the second is a page that was
       * read and had nothing in it, which a catalogue may want to RETAIN for a
       * later parser pass rather than log as an error.
       *
       * The library reports the answer directly, so a consumer never has to
       * regex-match `detail`.
       */
      bodyReceived?: boolean;
      /**
       * QUARANTINE-EVIDENCE-1: what tripped the guard, and enough of the page
       * to review it. Present only when `reason === 'quarantined'`.
       *
       * Without this a quarantine is indistinguishable from a fetch failure at
       * the call site, so a consumer whose policy is "never lose a page" has
       * nothing to build a review task from and drops it silently — the exact
       * outcome quarantining exists to prevent. A review task needs the
       * signals and the text to render at all.
       *
       * The text is SANITIZED, not raw: a reviewer needs to see what the page
       * said, not to be handed a live payload. Redactions are already applied.
       */
      quarantine?: {
        signals: PromptInjectionSignal[];
        /** Sanitized page text, capped at the crawl's maxTextChars. */
        text: string;
        title: string | null;
      };
      /** Present when the origin answered 429/503 WITH a Retry-After header.
       *  A retry loop that ignores this is the one that gets banned. */
      retryAfterMs?: number;
      /**
       * CRAWL-DEGRADE-1: is retrying worth it?
       *
       * `transient` — the world might differ next time (DNS blip, timeout,
       * 5xx, bot wall). Retry on your own schedule.
       * `structural` — retrying changes nothing until something is fixed
       * (404, robots disallow, inactive target, unsupported type).
       *
       * Count consecutive `structural` failures per source to retire a dead
       * one automatically. Counting `transient` ones tells you nothing.
       */
      failureClass?: FailureClass;
    };

export type CrawlFailureReason =
  /** Refused before any network call: inactive, robots, policy, bad URL. */
  | 'blocked'
  /** Network/DNS/timeout. */
  | 'unreachable'
  /** Fetched, but nothing usable came back. */
  | 'empty'
  /** Content tripped the prompt-injection guard and was quarantined. */
  | 'quarantined'
  /** Every configured lane was unavailable (e.g. vendor-only with no key). */
  | 'no_lane_available';

/** A usage/cost event. Emitted per external call so a consumer can meter
 *  spend without this package knowing what a database is. */
export type UsageEvent = {
  lane: LaneName;
  rung: string;
  /** 'fetch' | 'render' | 'search' | 'scrape' — coarse, for rollups. */
  kind: string;
  url?: string;
  /** Hostname of `url`, filled in for every event that carries a URL, so a
   *  consumer can roll spend and latency up per origin. */
  host?: string;
  ok: boolean;
  latencyMs: number;
  /** Vendor-reported or estimated cost, when the rung has one. Own-lane
   *  rungs are free and report 0. */
  costUsd?: number;
  error?: string;
};

export type { BudgetCheck, CrawlConfig, DnsAddress, DnsLookupFn, VendorKeys } from './config-types.js';

export const DEFAULT_MAX_TEXT_CHARS = 12000;
export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_MAX_PAGES = 5;

// ─── Extraction version ─────────────────────────────────────────────────────
//
// Bump when text, markdown, link or JSON-LD extraction changes in a way that would produce a DIFFERENT result
// for the same bytes, so a consumer holding a stored page can tell it came from an older extractor. It is not
// the package version: a fix to the address guard changes no extraction output and must not invalidate stored pages.
export const EXTRACTOR_VERSION = '2';
