// ─── LANE 1: the own lane ───────────────────────────────────────────────────
//
// Our crawler. No API keys, no vendor accounts, no per-call cost — platform
// fetch, cheerio parsing, and this package's own guards. It is what makes the
// package worth having: everything a vendor charges for on a plain HTML page,
// done here for free, with controls a vendor does not offer at all.
//
// Every rung in this lane is free and needs no credentials, except the remote
// render service, which runs on infrastructure YOU control — that is why it
// sits here rather than in the vendor lane. Falling through to the vendor lane
// happens only when the caller explicitly asked for it.
//
// docs/LANES.md is the rung table and the reasoning behind the order. Keep it
// there, not here: `freeFallbackLadder` below is the single definition of the
// order, and a second copy in this header would drift from it.

import * as cheerio from 'cheerio';
import { classifyContentType, refineKindByUrl } from '../../core/content-kind.js';
import { extractPdfText } from '../../fetch/pdf-extract.js';
import { forgetWinningRung, shouldSkipDirectFetch } from '../../core/rung-memory.js';
import { looksLikeBlockPage } from '../../core/block-page.js';
import { isQuarantined, buildPage, buildTextPage } from '../../fetch/build-page.js';
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
import type { ResolvedConfig } from '../../core/config.js';
import type { CrawlOptions, CrawlPage, CrawlResult, CrawlTarget } from '../../core/types.js';


// CRAWL-ROBOTS-1: robots.txt was ported but nothing ever CALLED it, so a
// "governed crawler" was only as governed as the consumer's bookkeeping. With
// config.autoRobots on, an 'unknown' posture is resolved for real and cached per
// HOST — one robots.txt request per host, not per page.
//
// ROBOTS-TTL-1: that cache had no expiry, and this comment once claimed
// long-lived processes never needed one — exactly backwards, since a long-lived
// process is the only place it matters. It broke both ways. A site ADDING a
// Disallow after we cached 'allow' kept being crawled for the life of the
// process, which is the one thing robots compliance exists to prevent. Worse, a
// transient failure cached 'unknown' permanently, and since unknown fails closed
// a single network blip meant that host never crawled again, silently. Fallow hit
// exactly this: 125 sources sat fail-closed for four days.
//
// The two TTLs are deliberately asymmetric: a successful answer is cheap to
// trust for hours, a failure must be retried soon, because the cost of holding
// it is a host that silently stops working.
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
 * Resolve a target's robots posture when the crawler is configured to.
 *
 * CRAWLSITE-AUTOROBOTS-1: crawlSite validates seeds before any lane runs, so
 * it needs the same resolution `crawl()` does internally. An explicit policy
 * is never overridden.
 */
export async function resolveTargetPolicy(target: CrawlTarget, config: ResolvedConfig): Promise<CrawlTarget> {
  if (!config.autoRobots || (target.robotsPolicy ?? 'unknown') !== 'unknown') return target;
  const policy = await resolveRobotsPolicy(target.baseUrl, config);
  return { ...target, robotsPolicy: policy };
}

/**
 * VENDOR-POLICY-1: the lane-independent policy gate — eligibility, robots
 * posture, same-site. Governance is a property of the CRAWL, not of which
 * network makes the request: before this, `lanes: ['vendor']` ran with no
 * vetting at all.
 *
 * Excludes the DNS-resolves-public check on purpose. That guards OUR socket
 * against SSRF, and in the vendor lane our machine never connects.
 *
 * Throws on refusal; callers convert to a `blocked` result.
 */
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
      return {
        ok: false, reason: 'quarantined', detail, lane: 'own',
        quarantine: { signals: sanitizedPdf.signals, text: sanitizedPdf.text, title: null },
      };
    }

    emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
    return {
      ok: true,
      pages: [
        await buildTextPage({
          url: response.url || requestUrl.toString(),
          text: sanitizedPdf.text,
          contentKind: 'pdf',
          contentType,
          rung: 'fetch',
          lane: 'own',
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
          redactionCount: sanitizedPdf.redactionCount,
          truncated: sanitizedPdf.truncated,
        }),
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
      return {
        ok: false, reason: 'quarantined', detail, lane: 'own',
        quarantine: { signals: sanitizedData.signals, text: sanitizedData.text, title: null },
      };
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
        await buildTextPage({
          url: response.url || requestUrl.toString(),
          text: sanitizedData.text,
          contentKind,
          contentType,
          rung: 'fetch',
          lane: 'own',
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
          bodySource: html,
          redactionCount: sanitizedData.redactionCount,
          truncated: sanitizedData.truncated,
        }),
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

  if (isQuarantined(page)) {
    const detail = 'Content tripped the prompt-injection guard and was quarantined.';
    emitUsage(config, { lane: 'own', rung: 'guard', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    // QUARANTINE-EVIDENCE-1: hand back what tripped it, so a consumer that must
    // never lose a page can raise a review task instead of dropping it.
    return {
      ok: false,
      reason: 'quarantined',
      detail,
      lane: 'own',
      quarantine: { signals: page.signals, text: page.text, title: page.title },
    };
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

  if (isQuarantined(page)) {
    const detail = 'Archived capture tripped the prompt-injection guard.';
    emitUsage(config, { lane: 'own', rung: 'guard', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    // QUARANTINE-EVIDENCE-1: the refusal carries what tripped it.
    return {
      ok: false,
      reason: 'quarantined',
      detail,
      lane: 'own',
      quarantine: { signals: page.signals, text: page.text, title: page.title },
    };
  }
  if (!page.text.trim() || looksLikeBlockPage(page.text)) return null;

  emitUsage(config, { lane: 'own', rung: 'archive', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
  return { ok: true, pages: [page] };
}

/**
 * The remaining FREE rungs, in one order defined once.
 *
 * LANE-EXHAUST-1: local Chromium -> your render service -> Jina. A skipped
 * free rung pushes the crawl into the paid lane sooner than it needed to go,
 * so every failure path routes through here rather than choosing its own.
 */
/**
 * Did the direct rung refuse because the origin redirected OFF-DOMAIN?
 *
 * Matched on the guard's own message, which is a coupling worth naming: the
 * test throws from the real guard and asserts this recognises the result, so
 * rewording the guard fails there rather than silently turning the signal off.
 */
function isOffDomainRefusal(detail: string): boolean {
  return /Blocked off-domain (redirect|crawl) URL/.test(detail);
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

  // JINA-CREDENTIAL-1 (found in audit): the Jina rung is a PUBLIC
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
  if (viaJina.ok) {
    // ORIGIN-MOVED-1: this rung stepped past a POLICY refusal, not a failed
    // fetch. Jina follows the same redirect from its own IPs, so a sold or
    // parked domain returns the new owner's content under the old URL — and
    // without this the caller sees an ordinary success. The refusal travels
    // with the page so a consumer can hold it for review.
    if (isOffDomainRefusal(priorDetail) && !viaJina.notModified) {
      return { ...viaJina, originMoved: { refusal: priorDetail, servedBy: 'jina' } };
    }
    return viaJina;
  }

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
  const localHtml = await renderViaLocalChromium(
    url,
    config.localRender === true,
    config.browserActions ?? [],
    config.dnsLookup,
    // RENDER-SILENT-1: a security refusal here is the signal an operator needs.
    (reason) =>
      emitUsage(config, { lane: 'own', rung: 'local-render', kind: 'render', url, ok: false, latencyMs: Date.now() - started, error: reason }),
  );
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
    if (isQuarantined(localPage)) {
      emitUsage(config, { lane: 'own', rung: 'local-render', kind: 'render', url, ok: false, latencyMs: Date.now() - started, error: 'quarantined' });
      // QUARANTINE-TELEMETRY-1: every rung reports its own quarantine.
      const detail = 'Locally rendered content tripped the prompt-injection guard.';
      emitUsage(config, { lane: 'own', rung: 'guard', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
      // QUARANTINE-EVIDENCE-1: the refusal carries what tripped it.
      return {
        ok: false,
        reason: 'quarantined',
        detail,
        lane: 'own',
        quarantine: { signals: localPage.signals, text: localPage.text, title: localPage.title },
      };
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

    if (isQuarantined(page)) {
      emitUsage(config, { lane: 'own', rung: 'browser-render', kind: 'render', url, ok: false, latencyMs: Date.now() - started, error: 'quarantined' });
      const detail = 'Rendered content tripped the prompt-injection guard.';
      emitUsage(config, { lane: 'own', rung: 'guard', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
      // QUARANTINE-EVIDENCE-1: the refusal carries what tripped it.
      return {
        ok: false,
        reason: 'quarantined',
        detail,
        lane: 'own',
        quarantine: { signals: page.signals, text: page.text, title: page.title },
      };
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
    const jina = await fetchViaJina(url, {
      ...(config.jinaEndpoint ? { endpoint: config.jinaEndpoint } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (!jina || !jina.text.trim()) {
      emitUsage(config, { lane: 'own', rung: 'jina', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: 'no content' });
      return { ok: false, reason: 'unreachable', detail: priorDetail, lane: 'own' };
    }

    const sanitized = sanitizeCrawledText(jina.text, maxTextChars);
    if (sanitized.signals.length > 0) {
      const detail = 'Prompt-injection signals in fallback content.';
      emitUsage(config, { lane: 'own', rung: 'guard', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
      // QUARANTINE-EVIDENCE-1. This site was MISSED when the decision shipped,
      // and it is the one that matters most: the Jina rung runs whenever the
      // direct fetch is bot-walled, so it is the common case rather than an
      // edge. A consumer whose policy is never to lose a page got a bare
      // refusal here and had to drop it.
      return {
        ok: false, reason: 'quarantined', detail, lane: 'own',
        quarantine: { signals: sanitized.signals, text: sanitized.text, title: jina.title ?? null },
      };
    }

    emitUsage(config, { lane: 'own', rung: 'jina', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
    return {
      ok: true,
      pages: [
        await buildTextPage({
          url,
          text: sanitized.text,
          contentKind: 'text',
          contentType: 'text/markdown',
          rung: 'jina',
          lane: 'own',
          title: jina.title,
          bodySource: jina.text,
          redactionCount: sanitized.redactionCount,
          truncated: sanitized.truncated,
        }),
      ],
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emitUsage(config, { lane: 'own', rung: 'jina', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    return { ok: false, reason: 'unreachable', detail: priorDetail, lane: 'own' };
  }
}

/** Headers the crawler owns; a target cannot override them. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'user-agent', 'accept-encoding']);

function targetHeaders(target: CrawlTarget): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(target.headers ?? {})) {
    if (!RESERVED_HEADERS.has(key.toLowerCase())) out[key.toLowerCase()] = value;
  }
  return out;
}
