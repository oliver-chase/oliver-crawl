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
   *  not-allowed by the default policy — fail closed. */
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
  /** Conditional-GET validators from a previous crawl of the same URL. When
   *  the origin answers 304, the crawl reports `notModified` and costs
   *  nothing further. */
  etag?: string | null;
  lastModified?: string | null;
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
  /** Full-body hash, and a nav/footer-insensitive content-region hash. A
   *  cosmetic header change moves the first but not the second, which is
   *  what makes "has this page really changed" cheap. */
  bodySha256: string;
  contentRegionSha256: string;
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
  /** Emitted per external call. Never awaited for correctness — a slow or
   *  throwing sink must not break a crawl. */
  onUsage?: (event: UsageEvent) => void;
  /** Consulted before each PAID call. */
  checkBudget?: BudgetCheck;
  /** Override DNS resolution (tests, or a DoH resolver on edge runtimes). */
  dnsLookup?: DnsLookupFn;
  /** Default caps, overridable per request. */
  defaults?: Required<Pick<CrawlOptions, 'maxTextChars' | 'timeoutMs' | 'maxPages'>>;
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
