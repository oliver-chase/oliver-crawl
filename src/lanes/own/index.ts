// ─── LANE 1: the own lane ───────────────────────────────────────────────────
//
// Our crawler. No API keys, no vendor accounts, no per-call cost — it fetches
// with the platform's own fetch, parses with cheerio, and applies the guards
// in this package. This is the lane that makes the package worth having:
// everything a vendor charges for on a plain HTML page, done here for free,
// with controls a vendor does not offer at all.
//
// What runs, in order, and why it stops early when it can:
//
//   1. Policy      — eligibility, same-site, SSRF/DNS-rebinding (host-policy)
//   2. Conditional — If-None-Match / If-Modified-Since. A 304 ends the crawl
//                    for free, which is the cheapest possible outcome and the
//                    common one for a page checked on a schedule.
//   3. Fetch       — with a real UA, redirect following re-validated per hop
//                    (a redirect is an attacker-controllable input).
//   4. Parse       — visible text, title, JSON-LD, same-site links, outbound
//                    hosts; SPA recovery from inline script payloads when the
//                    served HTML is a JS shell.
//   5. Guard       — prompt-injection sanitising BEFORE the text is returned,
//                    so an LLM downstream never sees unsanitised page content.
//   6. Hash        — full-body and content-region digests, so the caller can
//                    tell a real content change from a nav/footer tweak.
//   7. Local render — FREE local headless Chromium (config.localRender),
//                    for pages whose content only exists after JavaScript
//                    runs. Needs `npx playwright install chromium` once on
//                    the machine; absent, it degrades silently.
//   8. Remote render — YOUR render service (config.browserRender), for
//                    environments that cannot run a browser themselves.
//   9. Jina        — free, keyless last resort for pages the direct fetch
//                    cannot reach (bot walls, JS-only, moved hosts).
//
// Rungs 1-7 cost nothing and need no credentials. Rung 8 runs on
// infrastructure you control (which is why it is in THIS lane and not the
// vendor lane). Rung 9 is a free public service. If this lane fails, the
// caller may fall through to the vendor lane — but only if it asked for it.

import * as cheerio from 'cheerio';
import { summarizeStructuredData } from '../../extract/structured-summary.js';
import { classifyContentType, refineKindByUrl } from '../../core/content-kind.js';
import { extractPdfText } from '../../fetch/pdf-extract.js';
import { looksLikeEmptyState } from '../../core/soft-404.js';
import { EXTRACTOR_VERSION } from '../../core/extractor-version.js';
import { forgetWinningRung, shouldSkipDirectFetch } from '../../core/rung-memory.js';
import { looksLikeBlockPage } from '../../core/block-page.js';
import { buildPage } from '../../fetch/build-page.js';
import { parseRetryAfter, readBodyCapped, fetchFollowingSafeRedirects } from '../../fetch/http-mechanics.js';
import { fetchViaWayback } from '../../fetch/wayback-fetch.js';
import {
    assertRequestUrlAllowed,
  assertTargetEligible,
  assertHostResolvesToPublicAddress,
} from '../../fetch/host-policy.js';
import { fetchViaJina } from '../../fetch/jina-fetch.js';
import { renderServiceFrom, renderViaService } from '../../fetch/browser-render.js';
import { renderViaLocalChromium } from '../../fetch/local-render.js';
import { evaluateRobotsForUrl } from '../../fetch/robots-check.js';
import { emitUsage } from '../../core/usage.js';
import { throttleHost, recordHostLatency } from '../../core/host-throttle.js';
import { sanitizeCrawledText } from '../../guard/prompt-injection-guard.js';
import { sha256Hex } from '../../core/hash.js';
import type { ResolvedConfig } from '../../core/config.js';
import type { CrawlOptions, CrawlPage, CrawlResult, CrawlTarget } from '../../core/types.js';


// CRAWL-HARDEN-1: bytes read from any origin are capped (config.limits
// .maxBodyBytes, default 2 MB). Without a cap, a hostile or misconfigured
// origin streaming an endless body ties up memory until the process dies —
// response.text() reads EVERYTHING before returning. The sanitiser's char
// cap protects the LLM; this protects the crawler itself.

// CRAWL-ROBOTS-1: robots.txt was ported but nothing ever CALLED it — the lane
// trusted whatever robotsPolicy the caller set, so a "governed crawler" was
// only as governed as the consumer's bookkeeping. With config.autoRobots on,
// an 'unknown' posture is resolved for real, and cached per HOST so it costs
// one robots.txt request per host rather than one per page.
//
// ROBOTS-TTL-1 (2026-07-27, found in audit): that cache had no expiry at all,
// and the comment here claimed "long-lived processes never need this." Exactly
// backwards — a long-lived process is the only place it matters, and it broke
// in both directions:
//
//   1. A site that ADDS a Disallow after we cached 'allow' kept being crawled
//      for the life of the process. Crawling against an explicit refusal is
//      the one thing robots compliance exists to prevent.
//   2. Worse, a transient failure cached 'unknown' PERMANENTLY. Since unknown
//      fails closed, a single network blip meant that host never crawled
//      again — silently, with no error to notice. Fallow hit precisely this
//      shape: 125 sources sat fail-closed for four days before a human
//      spotted it (see its robots-recheck-sweep.ts).
//
// The two TTLs are deliberately asymmetric. A successful answer is stable and
// cheap to trust for hours. A failure must be retried soon, because the cost
// of holding it is a host that silently stops working.
export const ROBOTS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — resolved posture
export const ROBOTS_FAILURE_TTL_MS = 5 * 60 * 1000; //     5m — unresolved, retry soon

type RobotsPolicyValue = 'allow' | 'disallow' | 'conditional' | 'unknown';
type RobotsCacheEntry = { pending: Promise<RobotsPolicyValue>; expiresAt: number };

const ROBOTS_CACHE = new Map<string, RobotsCacheEntry>();

// ROBOTS-DELAY-1: a site's published Crawl-delay, per host, learned whenever
// robots.txt is resolved. Kept beside the policy cache rather than threaded
// through every call, because the throttle runs at a different point in the
// request than the policy check does.
const ROBOTS_DELAY_MS = new Map<string, number>();

/** The site's own Crawl-delay for this host, if we have seen its robots.txt. */
export function publishedCrawlDelayMs(hostname: string): number | null {
  return ROBOTS_DELAY_MS.get(hostname.toLowerCase()) ?? null;
}

/** Test seam. */
export function __clearRobotsCacheForTests(): void {
  ROBOTS_CACHE.clear();
  ROBOTS_DELAY_MS.clear();
}

async function resolveRobotsPolicy(url: string, config: ResolvedConfig): Promise<RobotsPolicyValue> {
  const host = new URL(url).hostname.toLowerCase();
  const now = Date.now();

  const hit = ROBOTS_CACHE.get(host);
  if (hit && now < hit.expiresAt) return hit.pending;

  // Held in a mutable entry so the TTL can be set from the OUTCOME once it is
  // known, while concurrent callers still share the one in-flight request.
  const entry: RobotsCacheEntry = {
    expiresAt: now + ROBOTS_FAILURE_TTL_MS,
    pending: Promise.resolve('unknown'),
  };

  entry.pending = evaluateRobotsForUrl(url, { userAgent: config.userAgent, dnsLookup: config.dnsLookup })
    .then((r) => {
      // 'unknown' from a real answer is still unresolved — retry it soon.
      entry.expiresAt = Date.now() + (r.policy === 'unknown' ? ROBOTS_FAILURE_TTL_MS : ROBOTS_CACHE_TTL_MS);
      if (r.crawlDelayMs !== null) ROBOTS_DELAY_MS.set(host, r.crawlDelayMs);
      return r.policy;
    })
    // A robots fetch that itself fails leaves the posture unknown, which still
    // fails closed downstream — never upgrade a failure to 'allow'. But it
    // expires quickly, so the failure cannot become permanent.
    .catch(() => {
      entry.expiresAt = Date.now() + ROBOTS_FAILURE_TTL_MS;
      return 'unknown' as const;
    });

  ROBOTS_CACHE.set(host, entry);
  return entry.pending;
}

/**
 * VENDOR-POLICY-1 (2026-07-27, found in audit): the lane-independent policy
 * gate — eligibility, robots posture (resolved for real under autoRobots),
 * and the same-site rule.
 *
 * Extracted from the own lane because the vendor lane's doc comment promised
 * "the caller is still expected to have vetted the URL (crawl() does)" while
 * crawl() only vetted INSIDE the own lane. `lanes: ['vendor']` therefore ran
 * with no vetting at all: no same-site check, no robots check, nothing —
 * paying Firecrawl to fetch a URL our own lane would have refused to touch.
 * Governance is a property of the CRAWL, not of which network makes the
 * request.
 *
 * Deliberately excludes the DNS-resolves-public check: that guards OUR
 * machine's socket against SSRF, and in the vendor lane our machine never
 * connects to the target. The vendor's network is the vendor's problem;
 * which URLs we are willing to crawl at all is ours.
 *
 * Throws on refusal; callers convert to a `blocked` result.
 */
/**
 * Resolve a target's robots posture, when the crawler is configured to.
 *
 * CRAWLSITE-AUTOROBOTS-1: crawlSite validates its seeds up front, before any
 * lane runs, so it needs the SAME resolution `crawl()` performs internally.
 * Without it, `autoRobots` silently did nothing for whole-site crawls and
 * every seed failed closed on a posture that would have resolved to 'allow'.
 *
 * Returns the target unchanged when autoRobots is off or a posture is already
 * set — an explicit policy is never overridden.
 */
export async function resolveTargetPolicy(target: CrawlTarget, config: ResolvedConfig): Promise<CrawlTarget> {
  if (!config.autoRobots || (target.robotsPolicy ?? 'unknown') !== 'unknown') return target;
  const policy = await resolveRobotsPolicy(target.baseUrl, config);
  return { ...target, robotsPolicy: policy };
}

export async function approveCrawlPolicy(
  target: CrawlTarget,
  url: string,
  config: ResolvedConfig,
): Promise<{ requestUrl: URL; effectiveTarget: CrawlTarget }> {
  let effectiveTarget = target;
  if (config.autoRobots && (target.robotsPolicy ?? 'unknown') === 'unknown') {
    const policy = await resolveRobotsPolicy(target.baseUrl, config);
    effectiveTarget = { ...target, robotsPolicy: policy };
  }
  assertTargetEligible(effectiveTarget);
  const requestUrl = assertRequestUrlAllowed(effectiveTarget, url);
  return { requestUrl, effectiveTarget };
}

/** Crawl a single URL with the own lane. */
export async function crawlWithOwnLane(
  target: CrawlTarget,
  url: string,
  config: ResolvedConfig,
  options: CrawlOptions = {},
): Promise<CrawlResult> {
  const maxTextChars = options.maxTextChars ?? config.defaults.maxTextChars;
  const timeoutMs = options.timeoutMs ?? config.defaults.timeoutMs;
  const started = Date.now();

  // 1. Policy — every refusal here happens before any content fetch. The
  // shared gate (also run lane-independently by crawl()) plus the own-lane-
  // only DNS check, which protects the socket THIS process is about to open.
  let requestUrl: URL;
  try {
    const approved = await approveCrawlPolicy(target, url, config);
    requestUrl = approved.requestUrl;
    await assertHostResolvesToPublicAddress(requestUrl.hostname, config.dnsLookup);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emitUsage(config, { lane: 'own', rung: 'policy', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    return { ok: false, reason: 'blocked', detail, lane: 'own' };
  }

  // Politeness: hold the per-host gap BEFORE the request, after policy has
  // already approved it — no point rate-limiting a fetch we will refuse.
  // ROBOTS-DELAY-1: the site's own Crawl-delay is a FLOOR, not a replacement.
  // Parsing robots.txt for permission and then ignoring its pacing is taking
  // only the half of the file that suits us — and it is a common way to get
  // blocked by a site that technically allowed you. A caller who configured a
  // slower interval still wins; this can only ever make us more polite.
  const publishedDelay = publishedCrawlDelayMs(requestUrl.hostname) ?? 0;
  await throttleHost(
    requestUrl.hostname,
    Math.max(config.minHostIntervalMs ?? 0, publishedDelay),
    config.adaptiveThrottleMultiplier ?? 0,
  );

  // BETTER-RUNGMEMORY-1: if this host is known to reject the plain fetch and
  // succeed on a later rung, skip straight there.
  //
  // Self-healing on the way back: if the remembered path now FAILS, the
  // memory is stale — the host may have stopped blocking, in which case the
  // fetch we skipped is exactly what would have worked. So the memory is
  // dropped and the normal ladder runs from the top. Without this, a rung
  // that goes down while a memory points at it costs the PAGE, not just an
  // extra request, and that would make this optimisation a liability.
  if (config.rungMemory !== false && shouldSkipDirectFetch(config.rungMemoryStore, requestUrl.hostname)) {
    const viaMemory = await freeFallbackLadder(
      url,
      config,
      options,
      started,
      'Direct fetch skipped: this host is known to serve it only via a later rung.',
      hasCredentials(target),
    );
    if (viaMemory.ok) return viaMemory;
    // A policy refusal is a decision, not a stale memory — do not re-probe.
    if (viaMemory.reason === 'blocked' || viaMemory.reason === 'quarantined') return viaMemory;
    forgetWinningRung(config.rungMemoryStore, requestUrl.hostname);
  }

  // 2-4. Direct fetch, conditional when the caller has validators from a
  // previous crawl of this URL.
  let response: Response;
  const fetchStartedAt = Date.now();
  try {
    response = await fetchFollowingSafeRedirects(
      requestUrl,
      config,
      timeoutMs,
      { etag: options.etag, lastModified: options.lastModified },
      targetHeaders(target),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    // Direct fetch failed — exhaust every remaining FREE rung before giving
    // up (and long before anything paid is considered).
    return freeFallbackLadder(url, config, options, started, detail, hasCredentials(target), target);
  }

  // How long the origin took is the input to adaptive pacing.
  recordHostLatency(requestUrl.hostname, Date.now() - fetchStartedAt);

  // A 304 is the whole point of sending validators: nothing changed, nothing
  // to parse, nothing charged. Reported distinctly from "empty".
  if (response.status === 304) {
    emitUsage(config, { lane: 'own', rung: 'conditional', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
    return { ok: true, pages: [], notModified: true };
  }

  if (!response.ok) {
    // CRAWL-BACKOFF-1: an origin answering 429/503 often states HOW LONG to
    // wait. Ignoring that and retrying on our own schedule is precisely the
    // behaviour that earns a crawler a ban, so the instruction is surfaced
    // for the retry loop to honour (see crawl-site.ts).
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    const detail = retryAfterMs
      ? `HTTP ${response.status} (origin asked to wait ${Math.round(retryAfterMs / 1000)}s)`
      : `HTTP ${response.status}`;
    emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    // A 403/429/503 is where a real browser most often succeeds — render
    // rungs come BEFORE Jina here (LANE-EXHAUST-1).
    const fallback = await freeFallbackLadder(url, config, options, started, detail, hasCredentials(target), target);
    if (!fallback.ok && retryAfterMs) return { ...fallback, retryAfterMs };
    return fallback;
  }

  const contentType = response.headers.get('content-type') || '';
  const kindRaw = classifyContentType(contentType);
  if (!kindRaw) {
    // Still refused: images, video, PDFs, binaries. HTML-parsing a JPEG
    // produces confident nonsense, and a PDF needs a real parser.
    const detail = `Unsupported content-type: ${contentType || 'unknown'}`;
    emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    return { ok: false, reason: 'empty', detail, lane: 'own' };
  }
  const contentKind = refineKindByUrl(kindRaw, response.url || requestUrl.toString());

  // CRAWL-PDF-1: a PDF is bytes, not text — decoding it as a string first
  // would corrupt it, so it is read and parsed before the text path.
  if (contentKind === 'pdf') {
    const buffer = new Uint8Array(await response.arrayBuffer());
    const extracted = await extractPdfText(buffer);

    if (!extracted.ok) {
      emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: extracted.detail });
      return { ok: false, reason: 'empty', detail: extracted.detail, lane: 'own' };
    }

    const sanitizedPdf = sanitizeCrawledText(extracted.text, maxTextChars);
    if (sanitizedPdf.signals.length > 0) {
      const detail = 'Prompt-injection signals in PDF content.';
      emitUsage(config, { lane: 'own', rung: 'guard', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
      return { ok: false, reason: 'quarantined', detail, lane: 'own' };
    }

    emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
    return {
      ok: true,
      pages: [
        {
          url: response.url || requestUrl.toString(),
          text: sanitizedPdf.text,
          markdown: '',
          contentKind: 'pdf',
          likelyEmptyState: looksLikeEmptyState(sanitizedPdf.text),
          candidateContentImages: [],
          extractorVersion: EXTRACTOR_VERSION,
          structuredData: summarizeStructuredData([]),
          title: null,
          contentType,
          bodySha256: await sha256Hex(sanitizedPdf.text),
          contentRegionSha256: '',
          textSha256: await sha256Hex(sanitizedPdf.text),
          httpEtag: response.headers.get('etag'),
          httpLastModified: response.headers.get('last-modified'),
          jsonLd: [],
          outboundHosts: [],
          links: [],
          lane: 'own',
          rung: 'fetch',
        },
      ],
    };
  }

  const html = await readBodyCapped(response, config.limits.maxBodyBytes);

  // CRAWL-FEED-1: a data document (ICS, CSV, JSON, RSS/Atom) is delivered
  // verbatim. Parsing it into events or rows is domain logic and belongs to
  // the caller — but the raw body has to REACH them, which it previously
  // never did. It still goes through the injection guard: a calendar feed is
  // untrusted remote text exactly like a page is.
  if (contentKind !== 'html') {
    const sanitizedData = sanitizeCrawledText(html, maxTextChars);
    if (sanitizedData.signals.length > 0) {
      const detail = `Prompt-injection signals in ${contentKind} content.`;
      emitUsage(config, { lane: 'own', rung: 'guard', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
      return { ok: false, reason: 'quarantined', detail, lane: 'own' };
    }
    if (!sanitizedData.text.trim()) {
      const detail = `Empty ${contentKind} document`;
      emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
      return { ok: false, reason: 'empty', detail, lane: 'own' };
    }

    emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
    return {
      ok: true,
      pages: [
        {
          url: response.url || requestUrl.toString(),
          text: sanitizedData.text,
          // No HTML, so no markdown, links, JSON-LD or structural hash to
          // derive. Empty rather than faked — same honesty rule as
          // contentRegionSha256 on the text-only rungs (CRAWL-HASH-1).
          markdown: '',
          contentKind,
          likelyEmptyState: looksLikeEmptyState(sanitizedData.text),
          candidateContentImages: [],
          extractorVersion: EXTRACTOR_VERSION,
          structuredData: summarizeStructuredData([]),
          title: null,
          contentType,
          bodySha256: await sha256Hex(html),
          contentRegionSha256: '',
          textSha256: await sha256Hex(sanitizedData.text),
          httpEtag: response.headers.get('etag'),
          httpLastModified: response.headers.get('last-modified'),
          jsonLd: [],
          outboundHosts: [],
          links: [],
          lane: 'own',
          rung: 'fetch',
        },
      ],
    };
  }
  const page = await buildPage({
    url: response.url || requestUrl.toString(),
    html,
    contentType,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    baseHost: requestUrl.hostname,
    maxTextChars,
    rung: 'fetch',
    includeHtml: options.includeHtml ?? false,
    maxLinks: config.limits.maxLinksPerPage,
    maxOutboundHosts: config.limits.maxOutboundHosts,
  });

  if (page === 'quarantined') {
    const detail = 'Content tripped the prompt-injection guard and was quarantined.';
    emitUsage(config, { lane: 'own', rung: 'guard', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    return { ok: false, reason: 'quarantined', detail, lane: 'own' };
  }

  if (!page.text.trim()) {
    // Served HTML had no readable text — a JS shell. Same free ladder.
    return freeFallbackLadder(url, config, options, started, 'No visible text in the served HTML', hasCredentials(target), target);
  }

  // THIN-PAGE-1: the page parsed and has text, but too little of it. A
  // JavaScript page often ships its nav and footer in the HTML and nothing
  // else, which passes an "is it empty" check while carrying no content.
  // Only runs when a caller sets a threshold — see renderWhenTextBelow.
  const thinThreshold = config.renderWhenTextBelow ?? 0;
  if (thinThreshold > 0 && page.text.trim().length < thinThreshold) {
    const rendered = await freeFallbackLadder(
      url,
      config,
      options,
      started,
      `Fetched page had only ${page.text.trim().length} characters (threshold ${thinThreshold})`,
      hasCredentials(target),
      target,
    );
    // Keep the thin page if nothing better came back — it is still the page.
    if (rendered.ok && !rendered.notModified && (rendered.pages[0]?.text.length ?? 0) > page.text.length) {
      return rendered;
    }
  }

  // LADDER-QUALITY-1: a bot wall served with HTTP 200. The text exists but it
  // is the wall, not the page — treat it exactly like the 403 form of the
  // same wall and try the rungs that clear it.
  if (looksLikeBlockPage(page.text)) {
    return freeFallbackLadder(url, config, options, started, 'Served a bot-wall interstitial (HTTP 200)', hasCredentials(target), target);
  }

  emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
  return { ok: true, pages: [page] };
}

/**
 * LANE-EXHAUST-1 (2026-07-27, found in audit): the remaining FREE rungs, in
 * order, as one function.
 *
 * Before this, a failed fetch (network error, or an HTTP status like a 403
 * bot wall) jumped straight to Jina and never tried rendering at all — while
 * only the "fetched but empty" path tried the render rungs. That is exactly
 * backwards for the most common blocking case: a 403 is precisely where a
 * real headless browser, with a real TLS fingerprint and real headers, tends
 * to succeed where a bare fetch cannot.
 *
 * The consequence was not just a missed page: skipping a free rung makes the
 * crawl fall through to the PAID lane sooner. Lane 1 must be exhausted before
 * lane 2 is reached, and defining the order in one place is what keeps that
 * true as rungs are added.
 *
 * Order: free local Chromium (your CPU) -> your own render service -> Jina
 * (free public). Returns null only when every rung declined.
 */
/**
 * WAYBACK-RUNG-1: the archive rung, gated hard.
 *
 * Only for an explicit `allow` posture, and only after every live rung has
 * failed. Returns null when it does not apply, so the caller falls through to
 * its normal failure.
 */
async function archiveFallback(
  target: CrawlTarget,
  url: string,
  config: ResolvedConfig,
  options: CrawlOptions,
  started: number,
): Promise<CrawlResult | null> {
  if (!config.useArchiveFallback) return null;
  // Anything other than an explicit allow means no.
  //
  // Currently REDUNDANT and kept deliberately: `approveCrawlPolicy` already
  // refuses disallow and unknown before any lane runs, so in the present code
  // path this line never fires — an ablation confirmed removing it breaks no
  // test. It stays because this function is one refactor away from being
  // reachable another way, and the cost of the check is nothing next to the
  // cost of an archive rung that reads pages a site refused.
  if (target.robotsPolicy !== 'allow') return null;
  // A credentialed page is not in a public archive, and looking for one there
  // would disclose the URL for nothing.
  if (Object.keys(target.headers ?? {}).length > 0) return null;

  const archived = await fetchViaWayback(url, {
    ...(config.archiveMaxAgeDays === undefined ? {} : { maxAgeDays: config.archiveMaxAgeDays }),
  });
  if (!archived.ok) return null;

  const page = await buildPage({
    url,
    html: archived.html,
    contentType: 'text/html',
    etag: null,
    lastModified: null,
    baseHost: new URL(url).hostname,
    maxTextChars: options.maxTextChars ?? config.defaults.maxTextChars,
    rung: 'archive',
    includeHtml: options.includeHtml ?? false,
    maxLinks: config.limits.maxLinksPerPage,
    maxOutboundHosts: config.limits.maxOutboundHosts,
  });

  if (page === 'quarantined') {
    const detail = 'Archived capture tripped the prompt-injection guard.';
    emitUsage(config, { lane: 'own', rung: 'guard', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    return { ok: false, reason: 'quarantined', detail, lane: 'own' };
  }
  if (!page.text.trim() || looksLikeBlockPage(page.text)) return null;

  emitUsage(config, { lane: 'own', rung: 'archive', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
  return { ok: true, pages: [page] };
}

async function freeFallbackLadder(
  url: string,
  config: ResolvedConfig,
  options: CrawlOptions,
  started: number,
  priorDetail: string,
  credentialed: boolean,
  target?: CrawlTarget,
): Promise<CrawlResult> {
  const rendered = await renderFallback(url, config, options, started);
  if (rendered) return rendered;

  // JINA-CREDENTIAL-1 (2026-07-27, found in audit): the Jina rung is a PUBLIC
  // third-party proxy — we hand it a URL and it fetches the page itself. For a
  // target the caller gave credentials for (a members-only calendar, a partner
  // feed), that is all downside:
  //
  //   - the private URL, including anything in its query string, is disclosed
  //     to a third party the caller never agreed to share it with;
  //   - the fetch cannot succeed anyway, because Jina does not have and must
  //     never be given those credentials.
  //
  // So a credentialed target stops at the rungs we run ourselves. The render
  // rungs above are fine — those are the caller's own infrastructure.
  if (credentialed) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: `${priorDetail} (Jina rung skipped: this target carries credentials and its URL must not be sent to a third-party proxy.)`,
      lane: 'own',
    };
  }

  const viaJina = await jinaFallback(url, config, options, started, priorDetail);
  if (viaJina.ok) return viaJina;

  // Last, and only for an explicitly permitted target — see archiveFallback.
  if (target) {
    const archived = await archiveFallback(target, url, config, options, started);
    if (archived) return archived;
  }
  return viaJina;
}

/** Does this target carry caller-supplied request headers (i.e. credentials)? */
function hasCredentials(target: CrawlTarget): boolean {
  return Object.keys(target.headers ?? {}).length > 0;
}

/**
 * Render rung: our own browser service, for pages whose content only exists
 * after JavaScript runs. Returns null when no service is configured (skip to
 * the next rung) — a configured-but-broken service reports the failure rather
 * than pretending the rung does not exist.
 */
async function renderFallback(
  url: string,
  config: ResolvedConfig,
  options: CrawlOptions,
  started: number,
): Promise<CrawlResult | null> {
  // FREE rung first: local Chromium (config.localRender). Costs nothing on
  // a machine that has it; silently absent everywhere else. Only then the
  // remote render service.
  const localHtml = await renderViaLocalChromium(url, config.localRender === true, config.browserActions ?? []);
  if (localHtml) {
    const localPage = await buildPage({
      url,
      html: localHtml,
      contentType: 'text/html',
      etag: null,
      lastModified: null,
      baseHost: new URL(url).hostname,
      maxTextChars: options.maxTextChars ?? config.defaults.maxTextChars,
      rung: 'local-render',
      includeHtml: options.includeHtml ?? false,
      maxLinks: config.limits.maxLinksPerPage,
      maxOutboundHosts: config.limits.maxOutboundHosts,
    });
    if (localPage === 'quarantined') {
      emitUsage(config, { lane: 'own', rung: 'local-render', kind: 'render', url, ok: false, latencyMs: Date.now() - started, error: 'quarantined' });
      const detail = 'Locally rendered content tripped the prompt-injection guard.';
      emitUsage(config, { lane: 'own', rung: 'guard', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
      return { ok: false, reason: 'quarantined', detail, lane: 'own' };
    }
    // LADDER-QUALITY-1: a rendered bot-wall interstitial is a rung FAILURE,
    // not content. Accepting it here beat the Jina rung, which retrieves the
    // real page — success reporting a security notice instead of the site.
    if (localPage.text.trim() && !looksLikeBlockPage(localPage.text)) {
      emitUsage(config, { lane: 'own', rung: 'local-render', kind: 'render', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
      return { ok: true, pages: [localPage] };
    }
    // Rendered but still empty — fall through to the remote service.
  }

  if (!renderServiceFrom(config)) return null;

  try {
    const rendered = await renderViaService(url, config);
    if (!rendered) return null;

    const page = await buildPage({
      url: rendered.url,
      html: rendered.html,
      contentType: rendered.contentType,
      etag: null,
      lastModified: null,
      baseHost: new URL(url).hostname,
      maxTextChars: options.maxTextChars ?? config.defaults.maxTextChars,
      rung: 'browser-render',
      includeHtml: options.includeHtml ?? false,
      maxLinks: config.limits.maxLinksPerPage,
      maxOutboundHosts: config.limits.maxOutboundHosts,
    });

    if (page === 'quarantined') {
      emitUsage(config, { lane: 'own', rung: 'browser-render', kind: 'render', url, ok: false, latencyMs: Date.now() - started, error: 'quarantined' });
      const detail = 'Rendered content tripped the prompt-injection guard.';
      emitUsage(config, { lane: 'own', rung: 'guard', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
      return { ok: false, reason: 'quarantined', detail, lane: 'own' };
    }

    // A render that still yields nothing is not a success — let the caller
    // fall through to Jina rather than returning an empty page.
    if (!page.text.trim() || looksLikeBlockPage(page.text)) return null;

    emitUsage(config, { lane: 'own', rung: 'browser-render', kind: 'render', url, ok: true, latencyMs: Date.now() - started });
    return { ok: true, pages: [page] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emitUsage(config, { lane: 'own', rung: 'browser-render', kind: 'render', url, ok: false, latencyMs: Date.now() - started, error: detail });
    return null; // broken render service must not end the crawl — Jina may still work
  }
}

/** Free, keyless last resort — see fetch/jina-fetch.ts for why it clears
 *  bot walls the direct fetch cannot. */
async function jinaFallback(
  url: string,
  config: ResolvedConfig,
  options: CrawlOptions,
  started: number,
  priorDetail: string,
): Promise<CrawlResult> {
  const maxTextChars = options.maxTextChars ?? config.defaults.maxTextChars;
  try {
    const jina = await fetchViaJina(url, config.jinaEndpoint ? { endpoint: config.jinaEndpoint } : undefined);
    if (!jina || !jina.text.trim()) {
      emitUsage(config, { lane: 'own', rung: 'jina', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: 'no content' });
      return { ok: false, reason: 'unreachable', detail: priorDetail, lane: 'own' };
    }

    const sanitized = sanitizeCrawledText(jina.text, maxTextChars);
    if (sanitized.signals.length > 0) {
      const detail = 'Prompt-injection signals in fallback content.';
      emitUsage(config, { lane: 'own', rung: 'guard', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
      return { ok: false, reason: 'quarantined', detail, lane: 'own' };
    }

    emitUsage(config, { lane: 'own', rung: 'jina', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
    return {
      ok: true,
      pages: [
        {
          url,
          text: sanitized.text,
          // No HTML to convert on a text-only rung. Empty rather than
          // pretending, same rule as contentRegionSha256 (CRAWL-HASH-1).
          markdown: '',
          contentKind: 'text',
          likelyEmptyState: looksLikeEmptyState(sanitized.text),
          // Text-only rung — no markup to scan for images.
          candidateContentImages: [],
          extractorVersion: EXTRACTOR_VERSION,
          // Jina returns prose, not the page's script tags — no JSON-LD to
          // summarise. Reported honestly as "none found", which correctly
          // tells a caller a model is their only option on this rung.
          structuredData: summarizeStructuredData([]),
          title: jina.title,
          contentType: 'text/markdown',
          bodySha256: await sha256Hex(jina.text),
          // Text-only rung: no HTML structure to strip, so no comparable
          // structural hash exists. Empty rather than a lookalike (CRAWL-HASH-1).
          contentRegionSha256: '',
          textSha256: await sha256Hex(sanitized.text),
          httpEtag: null,
          httpLastModified: null,
          jsonLd: [],
          outboundHosts: [],
          links: [],
          lane: 'own',
          rung: 'jina',
        },
      ],
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emitUsage(config, { lane: 'own', rung: 'jina', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    return { ok: false, reason: 'unreachable', detail: priorDetail, lane: 'own' };
  }
}

/**
 * Fetch with redirects followed MANUALLY, re-validating each hop. Automatic
 * redirect following would let an origin bounce the crawler to an internal
 * address after the initial checks passed — the redirect target is
 * attacker-controlled input and gets the same guard as the first URL.
 */
/** Headers the crawler owns; a target cannot override them. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'user-agent', 'accept-encoding']);

function targetHeaders(target: CrawlTarget): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(target.headers ?? {})) {
    if (!RESERVED_HEADERS.has(key.toLowerCase())) out[key.toLowerCase()] = value;
  }
  return out;
}
