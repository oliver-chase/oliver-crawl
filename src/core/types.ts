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
 * the origin app's own source registry has ~25 fields, none of which this package
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
  /** Hard ceiling on extracted text per page. Chars, not words: every limit
   *  downstream (sanitiser, token budgets) is expressed in chars. */
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
 * `'calendar'` (ICS) matters most: feed-discovery.ts hunts for these and
 * argues in its own header that they are more accurate and more stable than
 * scraping a page — and until CRAWL-FEED-1 the fetch rung refused to read
 * them, so the best source we could find was the one we could not use.
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
       * The case that forced this: isisasheville.com, a live source in the origin app, now
       * redirects to a Spanish medical centre — the domain was sold. The direct
       * rung correctly refuses the off-domain redirect; Jina then follows the
       * same redirect from its own IPs and returns the new owner's content, and
       * the crawl reported `ok: true` with no indication that the page belongs
       * to a different business.
       *
       * Refusing outright is the wrong fix. An off-domain redirect is routinely
       * a genuine migration, and this fleet has already reversed one over-strict
       * redirect rule that cost six live sources to stop one parked domain. So
       * the fallback still runs — but the refusal it stepped past travels with
       * the result, so a consumer can hold the page for review instead of
       * publishing content for a venue that no longer exists.
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
       * QUARANTINE-EVIDENCE-1: what tripped the guard, and enough of the page
       * to review it. Present only when `reason === 'quarantined'`.
       *
       * Without this a quarantine is indistinguishable from a fetch failure at
       * the call site, so a consumer whose policy is "never lose a page" has
       * nothing to build a review task from and drops it silently — the exact
       * outcome quarantining exists to prevent. the origin app's review task needs the
       * signals and the text to render at all.
       *
       * The text is SANITIZED, not raw: a reviewer needs to see what the page
       * said, not to be handed a live payload. Redactions are already applied.
       */
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
       * The origin app had to recover this by regex-matching `detail`, which is the
       * coupling that has silently switched several signals off in this fleet.
       * The library knows the answer; it should say it.
       */
      bodyReceived?: boolean;
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
  ok: boolean;
  latencyMs: number;
  /** Vendor-reported or estimated cost, when the rung has one. Own-lane
   *  rungs are free and report 0. */
  costUsd?: number;
  error?: string;
};

/** Called before each paid rung. Return false to veto the call — this is how
 *  a consumer enforces its own daily budget without this package importing
 *  one. Absent = always allowed. */
export type BudgetCheck = () => boolean | Promise<boolean>;

/** DNS answer shape used by the SSRF guard. Injectable so the guard is
 *  testable offline and portable across runtimes (Node dns vs DoH). */
export type DnsAddress = { address: string; family: number };
export type DnsLookupFn = (hostname: string) => Promise<DnsAddress[]>;

/** Everything the package needs to run. Explicit by rule 2 above. */
export type CrawlConfig = {
  /** Identifies the crawler to origins. Set this to YOUR bot name — the
   *  default is generic on purpose; shipping someone else's UA is rude and
   *  makes robots rules meaningless. */
  userAgent: string;
  /** Vendor lane credentials. Every one optional: a missing key disables
   *  exactly that rung and nothing else. */
  vendor?: VendorKeys;
  /** Order to try vendor rungs in when the vendor lane runs. */
  vendorRungOrder?: string[];
  /** Order to try SEARCH providers in. Separate from vendorRungOrder because
   *  search and scraping are different surfaces with different providers —
   *  Serper searches but cannot scrape; Firecrawl scrapes but is not the
   *  search rung here. */
  searchProviderOrder?: string[];
  /** Emitted per external call. Never awaited for correctness — a slow or
   *  throwing sink must not break a crawl. */
  onUsage?: (event: UsageEvent) => void;
  /** Consulted before each PAID call. */
  checkBudget?: BudgetCheck;
  /** Override DNS resolution (tests, or a DoH resolver on edge runtimes). */
  dnsLookup?: DnsLookupFn;
  /**
   * Self-hosted browser-rendering service for JS-only pages. Part of the OWN
   * lane, not the vendor lane, because it is YOUR infrastructure: point it at
   * a browserless container you run and it costs no per-call vendor fee.
   * Absent = the rung is skipped and the crawl falls through to Jina, exactly
   * as if it were never configured.
   */
  browserRender?: { url: string; token?: string };
  /**
   * FREE render rung: local headless Chromium via playwright, tried BEFORE
   * the remote render service. Explicit opt-in because the same code often
   * deploys to both a machine that can run a browser and a worker that
   * cannot — where rendering happens should be a choice, not a crash.
   * Requires `npx playwright install chromium` once on the machine; absent
   * playwright degrades silently to the next rung.
   */
  localRender?: boolean;
  /**
   * Fetch and evaluate robots.txt automatically when a target's own
   * robotsPolicy is 'unknown' (or unset), instead of failing closed on the
   * caller's missing bookkeeping.
   *
   * Off by default, deliberately: a consumer that already tracks robots
   * posture in its own database should keep that as the source of truth, and
   * silently adding a network call per target would be a surprise. Turned on,
   * it makes the crawler self-governing — the result is cached per host for
   * the process lifetime, so it costs one request per host, not per page.
   */
  autoRobots?: boolean;
  /** Default caps, overridable per request. */
  defaults?: Required<Pick<CrawlOptions, 'maxTextChars' | 'timeoutMs' | 'maxPages'>>;
  /**
   * Minimum gap between requests to the SAME host, process-wide and across
   * concurrent callers. Different hosts never wait on each other.
   *
   * Default 0 (off). crawlSite's own `politenessDelayMs` only governs one
   * run; this is what protects an origin when many targets share a host —
   * fifty venues on one CMS would otherwise all be hit at once.
   */
  minHostIntervalMs?: number;
  /**
   * Adaptive pacing: wait `avgResponseLatency x this` between requests to a
   * host, floored at minHostIntervalMs. 2 is a reasonable starting point —
   * a site answering in 100ms is polled briskly, one grinding at 3s is given
   * room. 0 (default) = fixed pacing only.
   *
   * Idea borrowed from Scrapy's AutoThrottle, implemented independently and
   * far more simply: latency is the origin telling you how much load it is
   * under, and a fixed delay cannot hear that. Can only ever make the
   * crawler MORE polite, never less.
   */
  adaptiveThrottleMultiplier?: number;
  /**
   * Cache successful crawls in memory for this many ms, so the same URL
   * fetched twice in quick succession costs one request. Default 0 (off) —
   * a cache that turns itself on is a cache that serves someone a stale page
   * they did not ask for. Failures and 304s are never cached.
   */
  cacheTtlMs?: number;
  /**
   * PARITY-ACTIONS-1: steps run against the page before it is captured, on
   * the local-render rung only. For "Load more" buttons and infinite-scroll
   * listings, where the first render genuinely lacks the content.
   *
   * Bounded by the library: at most 10 actions and 20 seconds total, no
   * navigation off the origin, and a failed step is skipped rather than
   * fatal (a missing "Load more" usually means everything already loaded).
   *
   * Never derive these from crawled page content. That would let a page you
   * fetched script the browser that fetched it.
   */
  browserActions?: BrowserAction[];
  /**
   * BETTER-RUNGMEMORY-1: remember which rung actually works per host, and
   * start there next time instead of re-walking the ladder from the top.
   *
   * On by default. A host that always rejects the plain fetch otherwise costs
   * a guaranteed wasted request on every page. Memory expires (30 min) and is
   * only ever a STARTING POINT — the full ladder stays available, so a stale
   * memory costs one extra request rather than a lost page.
   *
   * Set false for strictly reproducible per-call behaviour, e.g. in tests
   * that assert an exact request sequence.
   */
  rungMemory?: boolean;
  /**
   * JINA-SELFHOST-1: base URL for the reader rung. Defaults to the free
   * public `https://r.jina.ai/`.
   *
   * Point this at your own deployment of Jina's Apache-2.0 build
   * (`ghcr.io/jina-ai/reader:oss`) if you would rather not depend on a third
   * party's uptime for a rung the free ladder relies on.
   */
  jinaEndpoint?: string;
  /**
   * THIN-PAGE-1: escalate to the render rungs when a fetched page yields
   * fewer than this many characters, even though it yielded SOME.
   *
   * The ladder otherwise escalates only on an empty parse, so a JavaScript
   * page that ships a nav and a footer but no content reads as a success. One
   * measured case returned 1,232 characters of chrome from a plain fetch and
   * 5,519 once rendered.
   *
   * Opt-in with no default, because there is no way to know more content
   * exists without rendering, and rendering every short page would be a large
   * cost for pages that are simply short. 500–800 is a reasonable starting
   * point. Rendering a page that was already complete costs time, never data.
   */
  renderWhenTextBelow?: number;
  /**
   * WAYBACK-RUNG-1: fall back to the Internet Archive when every live rung
   * fails. Free and keyless. Off by default.
   *
   * Runs ONLY for targets whose robots posture is explicitly `allow` — never
   * on `disallow`, never on `unknown`. An archive fallback is otherwise a way
   * to read pages a site refused, which would make every other guard here
   * decorative.
   *
   * Always last: an archived copy is older than the live page by definition,
   * so it runs when the alternative is nothing at all.
   */
  useArchiveFallback?: boolean;
  /** Reject archived captures older than this. Unset means any age. */
  archiveMaxAgeDays?: number;
  /**
   * Safety/scale limits. Every one has a sane default; they are exposed
   * because the right value depends on YOUR pages, and a limit you cannot
   * raise is a limit that silently loses data.
   */
  limits?: {
    /** Max bytes read from any origin before truncating. Default 2 MB.
     *  Raise for genuinely huge listing pages; lower to harden further. */
    maxBodyBytes?: number;
    /** Max same-site links captured per page. Default 200. A big listing
     *  page can legitimately exceed this, and dropped links mean missed
     *  pagination and detail pages. */
    maxLinksPerPage?: number;
    /** Max distinct off-site hosts recorded per page. Default 25. */
    maxOutboundHosts?: number;
  };
  /**
   * DNS-over-HTTPS resolver used when no `dnsLookup` is supplied. Defaults
   * to Cloudflare. Exposed because which resolver sees your crawl traffic is
   * a privacy and third-party-dependency decision, not a detail — and on a
   * Node runtime you may prefer to inject `dnsLookup` and use none at all.
   */
  dohEndpoint?: string;
};

export type VendorKeys = {
  firecrawl?: string;
  apify?: string;
  tavily?: string;
  serper?: string;
};

export const DEFAULT_MAX_TEXT_CHARS = 12000;
export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_MAX_PAGES = 5;
