// ─── Configuration types ────────────────────────────────────────────────────
//
// What a caller hands to createCrawler: the config, the vendor keys, the budget hook and the DNS
// resolver shape. core/types.ts re-exports every name here.

import type { BrowserAction } from '../fetch/local-render.js';
import type { CrawlOptions, CrawlResult, UsageEvent } from './types.js';

/** Called before each paid rung. Return false to veto the call — this is how
 *  a consumer enforces its own daily budget without this package importing
 *  one. Absent = always allowed. */
export type BudgetCheck = () => boolean | Promise<boolean>;

/** DNS answer shape used by the SSRF guard. Injectable so the guard is
 *  testable offline and portable across runtimes (Node dns vs DoH). */
export type DnsAddress = { address: string; family: number };
export type DnsLookupFn = (hostname: string) => Promise<DnsAddress[]>;

/** Everything the package needs to run. Config is explicit (rule 2 in core/types.ts). */
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
   * robotsPolicy is 'unknown' (or unset). Without it the lane fails closed on the
   * caller's missing bookkeeping.
   *
   * Off by default, deliberately: a consumer that already tracks robots
   * posture in its own database should keep that as the source of truth, and
   * silently adding a network call per target would be a surprise. Turned on,
   * it makes the crawler self-governing — the result is cached per host (six
   * hours for an answer, five minutes for a failure), so it costs one request per host, not per page.
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
   * navigation off the origin, and a failed step is skipped and
   * never fatal (a missing "Load more" usually means everything already loaded).
   *
   * Never derive these from crawled page content. That would let a page you
   * fetched script the browser that fetched it.
   */
  browserActions?: BrowserAction[];
  /**
   * BETTER-RUNGMEMORY-1: remember which rung actually works per host, and
   * start there next time and skip re-walking the ladder from the top.
   *
   * On by default. A host that always rejects the plain fetch otherwise costs
   * a guaranteed wasted request on every page. Memory expires (30 min) and is
   * only ever a STARTING POINT — the full ladder stays available, so a stale
   * memory costs one extra request and never a lost page.
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
  /**
   * CRAWL-PROXY-1: a `fetch` that sends requests through YOUR proxy, for example
   * one built on undici's `ProxyAgent` or a gateway you run. It is tried when a
   * direct fetch is blocked, before Jina and before any paid lane, so a blocked
   * host costs a proxy request and no vendor credit.
   *
   * The address check still runs first, and every redirect is checked again. A
   * target that carries `headers` never uses it, because the library cannot
   * vouch for what the proxy does with credentials.
   */
  proxyFetch?: typeof fetch;
};

export type VendorKeys = {
  firecrawl?: string;
  apify?: string;
  tavily?: string;
  serper?: string;
};
