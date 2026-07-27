// ─── Core contract ──────────────────────────────────────────────────────────
//
// Everything in this package is built against these types. Three rules govern
// them, and they are why the package is reusable at all:
//
//   1. NO DATABASE. Nothing here imports a DB client. State that a consumer
//      wants persisted (usage, cost, learned recipes) leaves through injected
//      callbacks, so Fallow can write Supabase, OSG can write a Sheet, and a
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
 * Fallow's own source registry has ~25 fields, none of which this package
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

/** The result of a crawl. Ordinary failure is a value, not an exception. */
export type CrawlResult =
  | { ok: true; pages: CrawlPage[]; notModified?: false }
  | { ok: true; pages: []; notModified: true }
  | { ok: false; reason: CrawlFailureReason; detail: string; lane?: LaneName };

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
   * Safety/scale limits. Every one has a sane default; they are exposed
   * because the right value depends on YOUR pages, and a limit you cannot
   * raise is a limit that silently loses data.
   */
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
   * Cache successful crawls in memory for this many ms, so the same URL
   * fetched twice in quick succession costs one request. Default 0 (off) —
   * a cache that turns itself on is a cache that serves someone a stale page
   * they did not ask for. Failures and 304s are never cached.
   */
  cacheTtlMs?: number;
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
