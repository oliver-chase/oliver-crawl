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
import {
  assertRedirectUrlAllowedForHost,
  assertRequestUrlAllowed,
  assertTargetEligible,
  assertHostResolvesToPublicAddress,
} from '../../fetch/host-policy.js';
import { fetchViaJina } from '../../fetch/jina-fetch.js';
import { renderServiceFrom, renderViaService } from '../../fetch/browser-render.js';
import { renderViaLocalChromium } from '../../fetch/local-render.js';
import { evaluateRobotsForUrl } from '../../fetch/robots-check.js';
import { sanitizeCrawledText } from '../../guard/prompt-injection-guard.js';
import { computeContentRegionHash } from '../../extract/content-region-hash.js';
import { extractInlineScriptContent, shouldRecoverFromScripts } from '../../extract/spa-content-extract.js';
import { sha256Hex } from '../../core/hash.js';
import type { ResolvedConfig } from '../../core/config.js';
import type { CrawlOptions, CrawlPage, CrawlResult, CrawlTarget, PageLink } from '../../core/types.js';

const MAX_OUTBOUND_HOSTS = 25;
const MAX_LINKS = 200;

// CRAWL-HARDEN-1: hard cap on bytes read from any origin. Without one, a
// hostile or misconfigured origin streaming an endless (or multi-hundred-MB)
// body ties up memory until the process dies — response.text() reads
// EVERYTHING before returning. 2 MB is far above any real event/listing page
// and far below anything that could hurt; the sanitiser's char cap protects
// the LLM, this protects the crawler itself.
const MAX_BODY_BYTES = 2_000_000;

// CRAWL-ROBOTS-1: robots.txt was ported but nothing ever CALLED it — the lane
// trusted whatever robotsPolicy the caller set, so a "governed crawler" was
// only as governed as the consumer's bookkeeping. With config.autoRobots on,
// an 'unknown' posture is resolved for real. Cached per host for the process
// lifetime: one robots.txt request per HOST, never per page.
const ROBOTS_CACHE = new Map<string, Promise<'allow' | 'disallow' | 'conditional' | 'unknown'>>();

/** Test seam — long-lived processes never need this. */
export function __clearRobotsCacheForTests(): void {
  ROBOTS_CACHE.clear();
}

async function resolveRobotsPolicy(url: string, config: ResolvedConfig) {
  const host = new URL(url).hostname.toLowerCase();
  let pending = ROBOTS_CACHE.get(host);
  if (!pending) {
    pending = evaluateRobotsForUrl(url, { userAgent: config.userAgent, dnsLookup: config.dnsLookup })
      .then((r) => r.policy)
      // A robots fetch that itself fails leaves the posture unknown, which
      // still fails closed downstream — never upgrade a failure to 'allow'.
      .catch(() => 'unknown' as const);
    ROBOTS_CACHE.set(host, pending);
  }
  return pending;
}

/** Read a response body up to `maxBytes`, truncating (not failing) beyond it —
 *  the readable prefix of a huge page is still worth extracting from. */
async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Runtime without streaming bodies — fall back, but refuse an announced
    // oversize rather than buffering it.
    const announced = Number(response.headers.get('content-length') || 0);
    if (announced > maxBytes) throw new Error(`Response too large: content-length ${announced} > ${maxBytes}`);
    return response.text();
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  const merged = new Uint8Array(Math.min(received, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const room = merged.byteLength - offset;
    if (room <= 0) break;
    merged.set(room >= chunk.byteLength ? chunk : chunk.subarray(0, room), offset);
    offset += Math.min(chunk.byteLength, room);
  }
  return new TextDecoder().decode(merged);
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

  // 1. Policy — every refusal here happens before any content fetch.
  let requestUrl: URL;
  try {
    // CRAWL-ROBOTS-1: resolve an unknown posture for real, when asked to.
    let effectiveTarget = target;
    if (config.autoRobots && (target.robotsPolicy ?? 'unknown') === 'unknown') {
      const policy = await resolveRobotsPolicy(target.baseUrl, config);
      effectiveTarget = { ...target, robotsPolicy: policy };
    }
    assertTargetEligible(effectiveTarget);
    requestUrl = assertRequestUrlAllowed(effectiveTarget, url);
    await assertHostResolvesToPublicAddress(requestUrl.hostname, config.dnsLookup);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emit(config, { lane: 'own', rung: 'policy', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    return { ok: false, reason: 'blocked', detail, lane: 'own' };
  }

  // 2-4. Direct fetch, conditional when the caller has validators from a
  // previous crawl of this URL.
  let response: Response;
  try {
    response = await fetchFollowingSafeRedirects(requestUrl, config, timeoutMs, {
      etag: options.etag,
      lastModified: options.lastModified,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emit(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    // Direct fetch failed — try the free keyless fallback before giving up.
    return jinaFallback(target, url, config, options, started, detail);
  }

  // A 304 is the whole point of sending validators: nothing changed, nothing
  // to parse, nothing charged. Reported distinctly from "empty".
  if (response.status === 304) {
    emit(config, { lane: 'own', rung: 'conditional', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
    return { ok: true, pages: [], notModified: true };
  }

  if (!response.ok) {
    const detail = `HTTP ${response.status}`;
    emit(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    return jinaFallback(target, url, config, options, started, detail);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
    const detail = `Unsupported content-type: ${contentType || 'unknown'}`;
    emit(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    return { ok: false, reason: 'empty', detail, lane: 'own' };
  }

  const html = await readBodyCapped(response, MAX_BODY_BYTES);
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
  });

  if (page === 'quarantined') {
    const detail = 'Content tripped the prompt-injection guard and was quarantined.';
    emit(config, { lane: 'own', rung: 'guard', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    return { ok: false, reason: 'quarantined', detail, lane: 'own' };
  }

  if (!page.text.trim()) {
    // Served HTML had no readable text — a JS shell. Try our own render
    // service first (infrastructure we control), then the free Jina rung.
    const rendered = await renderFallback(url, config, options, started);
    if (rendered) return rendered;
    return jinaFallback(target, url, config, options, started, 'No visible text in the served HTML');
  }

  emit(config, { lane: 'own', rung: 'fetch', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
  return { ok: true, pages: [page] };
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
  const localHtml = await renderViaLocalChromium(url, config.localRender === true);
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
    });
    if (localPage === 'quarantined') {
      emit(config, { lane: 'own', rung: 'local-render', kind: 'render', url, ok: false, latencyMs: Date.now() - started, error: 'quarantined' });
      return { ok: false, reason: 'quarantined', detail: 'Locally rendered content tripped the prompt-injection guard.', lane: 'own' };
    }
    if (localPage.text.trim()) {
      emit(config, { lane: 'own', rung: 'local-render', kind: 'render', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
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
    });

    if (page === 'quarantined') {
      emit(config, { lane: 'own', rung: 'browser-render', kind: 'render', url, ok: false, latencyMs: Date.now() - started, error: 'quarantined' });
      return { ok: false, reason: 'quarantined', detail: 'Rendered content tripped the prompt-injection guard.', lane: 'own' };
    }

    // A render that still yields nothing is not a success — let the caller
    // fall through to Jina rather than returning an empty page.
    if (!page.text.trim()) return null;

    emit(config, { lane: 'own', rung: 'browser-render', kind: 'render', url, ok: true, latencyMs: Date.now() - started });
    return { ok: true, pages: [page] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emit(config, { lane: 'own', rung: 'browser-render', kind: 'render', url, ok: false, latencyMs: Date.now() - started, error: detail });
    return null; // broken render service must not end the crawl — Jina may still work
  }
}

/** Free, keyless last resort — see fetch/jina-fetch.ts for why it clears
 *  bot walls the direct fetch cannot. */
async function jinaFallback(
  target: CrawlTarget,
  url: string,
  config: ResolvedConfig,
  options: CrawlOptions,
  started: number,
  priorDetail: string,
): Promise<CrawlResult> {
  const maxTextChars = options.maxTextChars ?? config.defaults.maxTextChars;
  try {
    const jina = await fetchViaJina(url);
    if (!jina || !jina.text.trim()) {
      emit(config, { lane: 'own', rung: 'jina', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: 'no content' });
      return { ok: false, reason: 'unreachable', detail: priorDetail, lane: 'own' };
    }

    const sanitized = sanitizeCrawledText(jina.text, maxTextChars);
    if (sanitized.signals.length > 0) {
      return { ok: false, reason: 'quarantined', detail: 'Prompt-injection signals in fallback content.', lane: 'own' };
    }

    emit(config, { lane: 'own', rung: 'jina', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
    return {
      ok: true,
      pages: [
        {
          url,
          text: sanitized.text,
          title: jina.title,
          contentType: 'text/markdown',
          bodySha256: await sha256Hex(jina.text),
          contentRegionSha256: await sha256Hex(sanitized.text),
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
    emit(config, { lane: 'own', rung: 'jina', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error: detail });
    return { ok: false, reason: 'unreachable', detail: priorDetail, lane: 'own' };
  }
}

/**
 * Fetch with redirects followed MANUALLY, re-validating each hop. Automatic
 * redirect following would let an origin bounce the crawler to an internal
 * address after the initial checks passed — the redirect target is
 * attacker-controlled input and gets the same guard as the first URL.
 */
async function fetchFollowingSafeRedirects(
  url: URL,
  config: ResolvedConfig,
  timeoutMs: number,
  validators: { etag?: string | null; lastModified?: string | null } = {},
  maxHops = 5,
): Promise<Response> {
  let current = url;
  const baseHost = url.hostname;
  const basePort = url.port || '';

  // CRAWL-VALIDATE-1 (2026-07-27, found in self-audit): the FIRST version of
  // this accepted etag/lastModified in CrawlOptions, documented the free-304
  // path in the lane header, had the 304 branch in the caller — and never
  // sent If-None-Match / If-Modified-Since on the wire. The 304 test passed
  // only because its stub returned 304 unconditionally, so the whole
  // "cheapest crawl is the one that doesn't happen" story was dead code
  // against a real origin. Headers are sent on every hop: harmless on a
  // redirect (redirects don't 304), correct on the final resource.
  const conditionalHeaders: Record<string, string> = {};
  if (validators.etag) conditionalHeaders['if-none-match'] = validators.etag;
  if (validators.lastModified) conditionalHeaders['if-modified-since'] = validators.lastModified;

  for (let hop = 0; hop <= maxHops; hop++) {
    const response = await fetch(current, {
      redirect: 'manual',
      headers: {
        'user-agent': config.userAgent,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        ...conditionalHeaders,
      },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });

    if (response.status < 300 || response.status > 399) return response;

    const location = response.headers.get('location');
    if (!location) return response;

    const next = new URL(location, current);
    // Throws on off-domain/downgrade/private — the caller turns that into a
    // blocked/unreachable result rather than silently following.
    assertRedirectUrlAllowedForHost(baseHost, basePort, next.toString());
    await assertHostResolvesToPublicAddress(next.hostname, config.dnsLookup);
    current = next;
  }

  throw new Error(`Too many redirects (>${maxHops}) starting at ${url.toString()}`);
}

async function buildPage(input: {
  url: string;
  html: string;
  contentType: string;
  etag: string | null;
  lastModified: string | null;
  baseHost: string;
  maxTextChars: number;
  rung: string;
  includeHtml: boolean;
}): Promise<CrawlPage | 'quarantined'> {
  // ONE parse (CRAWL-PERF-1, found in self-audit): the first version loaded
  // the document once for text, then RELOADED it once per JSON-LD script tag
  // inside the .each — N+1 full parses on a page with N structured-data
  // blocks. JSON-LD is read from this same tree BEFORE the script tags are
  // stripped for text extraction.
  const $ = cheerio.load(input.html);

  const jsonLd: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    try {
      jsonLd.push(JSON.parse(raw));
    } catch {
      // Malformed JSON-LD is common in the wild — skip this block, keep the rest.
    }
  });

  const title = $('title').first().text().trim() || null;

  $('script, style, noscript, template').remove();
  let visibleText = $('body').text().replace(/\s+/g, ' ').trim();

  // A JS shell serves no readable body but often ships its content as an
  // inline JSON payload — recover it rather than reporting the page empty.
  if (shouldRecoverFromScripts(visibleText)) {
    const recovered = extractInlineScriptContent(input.html);
    if (recovered && recovered.length > visibleText.length) visibleText = recovered;
  }

  // Guard BEFORE returning: nothing downstream should ever see raw page text.
  const sanitized = sanitizeCrawledText(visibleText, input.maxTextChars);
  if (sanitized.signals.length > 0) return 'quarantined';

  const links: PageLink[] = [];
  const outbound = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let resolved: URL;
    try {
      resolved = new URL(href, input.url);
    } catch {
      return;
    }
    if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return;

    const sameSite = resolved.hostname.replace(/^www\./, '') === input.baseHost.replace(/^www\./, '');
    if (sameSite) {
      if (links.length < MAX_LINKS) links.push({ url: resolved.toString(), text: $(el).text().trim().slice(0, 200) });
    } else if (outbound.size < MAX_OUTBOUND_HOSTS) {
      outbound.add(resolved.hostname);
    }
  });

  return {
    url: input.url,
    text: sanitized.text,
    title,
    ...(input.includeHtml ? { html: input.html } : {}),
    contentType: input.contentType,
    bodySha256: await sha256Hex(input.html),
    contentRegionSha256: await computeContentRegionHash(input.html),
    httpEtag: input.etag,
    httpLastModified: input.lastModified,
    jsonLd,
    outboundHosts: [...outbound],
    links,
    lane: 'own',
    rung: input.rung,
  };
}

/** Usage emission must never break a crawl — a consumer's sink is not
 *  trusted to be fast or total. */
function emit(config: ResolvedConfig, event: Parameters<NonNullable<ResolvedConfig['onUsage']>>[0]): void {
  try {
    config.onUsage?.(event);
  } catch {
    // deliberately swallowed
  }
}
