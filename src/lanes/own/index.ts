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
import { classifyContentType, refineKindByUrl } from '../../core/content-kind.js';
import { extractPdfText } from '../../fetch/pdf-extract.js';
import { forgetWinningRung, shouldSkipDirectFetch } from '../../core/rung-memory.js';
import { looksLikeBlockPage } from '../../core/block-page.js';
import { isQuarantined, buildTextPage } from '../../fetch/build-page.js';
import { buildRungPage, quarantined } from './rung-page.js';
import { dropBody, parseRetryAfter, readBodyCapped, readBytesCapped, fetchFollowingSafeRedirects } from '../../fetch/http-mechanics.js';
import { assertHostResolvesToPublicAddress, DnsLookupError } from '../../fetch/host-policy.js';
import { emitUsage } from '../../core/usage.js';
import { throttleHost, recordHostLatency } from '../../core/host-throttle.js';
import { sanitizeCrawledText } from '../../guard/prompt-injection-guard.js';
import type { ResolvedConfig } from '../../core/config.js';
import type { CrawlOptions, CrawlResult, CrawlTarget } from '../../core/types.js';
import { approveCrawlPolicy, publishedCrawlDelayMs } from './robots-policy.js';
import { freeFallbackLadder } from './fallback-rungs.js';
import { hasCredentials, targetHeaders } from './target-headers.js';
export { ROBOTS_CACHE_TTL_MS, ROBOTS_FAILURE_TTL_MS, publishedCrawlDelayMs, __clearRobotsCacheForTests, resolveTargetPolicy, approveCrawlPolicy } from './robots-policy.js';
export { __isOffDomainRefusalForTests } from './origin-moved.js';

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
    // A resolver failure is a transport fault that can clear, so it is reported as unreachable and not as a policy refusal.
    if (error instanceof DnsLookupError) return { ok: false, reason: 'unreachable', detail, lane: 'own' };
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
  // LANE-ONCE-1: when the remembered path fails, its ladder has already tried every later rung, so a failure
  // of the direct fetch that follows returns that result and does not run the ladder a second time.
  let spentLadder: CrawlResult | null = null;
  const ladder = (...args: Parameters<typeof freeFallbackLadder>): Promise<CrawlResult> =>
    spentLadder ? Promise.resolve(spentLadder) : freeFallbackLadder(...args);
  if (config.rungMemory !== false && shouldSkipDirectFetch(config.rungMemoryStore, requestUrl.hostname)) {
    const viaMemory = await freeFallbackLadder(
      url,
      config,
      options,
      started,
      'Direct fetch skipped: this host is known to serve it only via a later rung.',
      hasCredentials(target),
      target,
    );
    if (viaMemory.ok) return viaMemory;
    // A policy refusal is a decision, not a stale memory — do not re-probe.
    if (viaMemory.reason === 'blocked' || viaMemory.reason === 'quarantined') return viaMemory;
    forgetWinningRung(config.rungMemoryStore, requestUrl.hostname);
    spentLadder = viaMemory;
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
    return ladder(url, config, options, started, detail, hasCredentials(target), target);
  }

  // How long the origin took is the input to adaptive pacing.
  recordHostLatency(requestUrl.hostname, Date.now() - fetchStartedAt);

  // A 304 is the whole point of sending validators: nothing changed, nothing
  // to parse, nothing charged. Reported distinctly from "empty".
  // A 304 answers a conditional request. With no validators sent it is not "unchanged", it is a fault.
  if (response.status === 304 && (options.etag || options.lastModified)) {
    dropBody(response);
    emitUsage(config, { lane: 'own', rung: 'conditional', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
    return { ok: true, pages: [], notModified: true };
  }

  if (!response.ok) {
    // CRAWL-BACKOFF-1: an origin answering 429/503 often states HOW LONG to
    // wait. Ignoring that and retrying on our own schedule is precisely the
    // behaviour that earns a crawler a ban, so the instruction is surfaced
    // for the retry loop to honour (see crawl-site.ts).
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    dropBody(response);
    const detail = retryAfterMs
      ? `HTTP ${response.status} (origin asked to wait ${Math.round(retryAfterMs / 1000)}s)`
      : `HTTP ${response.status}`;
    emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    // A 403/429/503 is where a real browser most often succeeds — render
    // rungs come BEFORE Jina here (LANE-EXHAUST-1).
    // A 404 or 410 is the origin saying the page is gone, so no live rung can bring it back. Only the archive can.
    const gone = response.status === 404 || response.status === 410;
    const fallback = await ladder(url, config, options, started, detail, hasCredentials(target), target, false, !gone);
    if (!fallback.ok && retryAfterMs) return { ...fallback, retryAfterMs };
    return fallback;
  }

  const contentType = response.headers.get('content-type') || '';
  const kindRaw = classifyContentType(contentType);
  if (!kindRaw) {
    // Still refused: images, video, PDFs, binaries. HTML-parsing a JPEG
    // produces confident nonsense, and a PDF needs a real parser.
    dropBody(response);
    const detail = `Unsupported content-type: ${contentType || 'unknown'}`;
    emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    return { ok: false, reason: 'empty', detail, lane: 'own' };
  }
  const contentKind = refineKindByUrl(kindRaw, response.url || requestUrl.toString());

  // CRAWL-PDF-1: a PDF is bytes, not text — decoding it as a string first
  // would corrupt it, so it is read and parsed before the text path.
  if (contentKind === 'pdf') {
    // CRAWL-PDF-CAP-1: the same byte cap as the text path, applied before the bytes are parsed.
    const announced = Number(response.headers.get('content-length') || 0);
    if (announced > config.limits.maxBodyBytes) {
      const detail = `PDF too large: content-length ${announced} > ${config.limits.maxBodyBytes}`;
      emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
      return { ok: false, reason: 'empty', detail, lane: 'own' };
    }
    let buffer: Uint8Array;
    try {
      buffer = await readBytesCapped(response, config.limits.maxBodyBytes);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
      return { ok: false, reason: 'empty', detail, lane: 'own' };
    }
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
  const page = await buildRungPage(config, options, {
      url: response.url || requestUrl.toString(),
      html,
      contentType,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      baseHost: requestUrl.hostname,
      maxTextChars,
      rung: 'fetch',
    });

  if (isQuarantined(page)) {
    const detail = 'Content tripped the prompt-injection guard and was quarantined.';
    return quarantined(config, url, started, detail, page);
  }

  if (!page.text.trim()) {
    // Served HTML had no readable text — a JS shell. Same free ladder.
    // BODY-RECEIVED-1: an origin DID answer here — the page simply had no
    // readable text. The ladder's later rungs cannot know that, so it is
    // recorded now rather than inferred from wording afterwards.
    return ladder(url, config, options, started, 'No visible text in the served HTML', hasCredentials(target), target, true);
  }

  // THIN-PAGE-1: the page parsed and has text, but too little of it. A
  // JavaScript page often ships its nav and footer in the HTML and nothing
  // else, which passes an "is it empty" check while carrying no content.
  // Only runs when a caller sets a threshold — see renderWhenTextBelow.
  const thinThreshold = config.renderWhenTextBelow ?? 0;
  if (thinThreshold > 0 && page.text.trim().length < thinThreshold) {
    const rendered = await ladder(
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
    return ladder(url, config, options, started, 'Served a bot-wall interstitial (HTTP 200)', hasCredentials(target), target);
  }

  emitUsage(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
  return { ok: true, pages: [page] };
}
