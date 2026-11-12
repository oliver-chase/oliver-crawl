// ─── Fallback rungs of the own lane ─────────────────────────────────────────
//
// The rungs that run after the direct fetch fails: render, proxy, Jina and the archive, and the ladder that orders them.
// docs/LANES.md is the rung table.

import { classifyContentType } from '../../core/content-kind.js';
import { looksLikeBlockPage } from '../../core/block-page.js';
import { isQuarantined, buildTextPage } from '../../fetch/build-page.js';
import { buildRungPage, quarantined } from './rung-page.js';
import { readBodyCapped, fetchFollowingSafeRedirects } from '../../fetch/http-mechanics.js';
import { fetchViaWayback } from '../../fetch/wayback-fetch.js';
import { fetchViaJina } from '../../fetch/jina-fetch.js';
import { renderServiceFrom, renderViaService } from '../../fetch/browser-render.js';
import { renderViaLocalChromium } from '../../fetch/local-render.js';
import { emitUsage } from '../../core/usage.js';
import { sanitizeCrawledText } from '../../guard/prompt-injection-guard.js';
import type { ResolvedConfig } from '../../core/config.js';
import type { CrawlOptions, CrawlResult, CrawlTarget } from '../../core/types.js';
import { withOriginMoved } from './origin-moved.js';

/**
 * WAYBACK-RUNG-1: the archive rung, gated hard.
 *
 * Only for an explicit `allow` posture, and only after every live rung has
 * failed. Returns null when it does not apply, so the caller falls through to
 * its normal failure.
 */
export async function archiveFallback(
  url: string,
  config: ResolvedConfig,
  options: CrawlOptions,
  started: number,
): Promise<CrawlResult | null> {
  if (!config.useArchiveFallback) return null;
  // approveCrawlPolicy has already refused disallow and unknown, and freeFallbackLadder stops a
  // credentialed target before it reaches here, so this rung sees only permitted public targets.
  const archived = await fetchViaWayback(url, {
    ...(config.archiveMaxAgeDays === undefined ? {} : { maxAgeDays: config.archiveMaxAgeDays }),
  });
  if (!archived.ok) return null;

  const page = await buildRungPage(config, options, {
      url,
      html: archived.html,
      contentType: 'text/html',
      etag: null,
      lastModified: null,
      baseHost: new URL(url).hostname,
      rung: 'archive',
    });

  if (isQuarantined(page)) {
    const detail = 'Archived capture tripped the prompt-injection guard.';
    return quarantined(config, url, started, detail, page);
  }
  if (!page.text.trim() || looksLikeBlockPage(page.text)) return null;

  emitUsage(config, { lane: 'own', rung: 'archive', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
  return { ok: true, pages: [page] };
}

/**
 * The remaining FREE rungs, in one order defined once.
 *
 * LANE-EXHAUST-1: local Chromium -> your render service -> your proxy -> Jina. A skipped
 * free rung pushes the crawl into the paid lane sooner than it needed to go,
 * so every failure path routes through here rather than choosing its own.
 */
export async function freeFallbackLadder(
  url: string,
  config: ResolvedConfig,
  options: CrawlOptions,
  started: number,
  priorDetail: string,
  credentialed: boolean,
  target?: CrawlTarget,
  bodyReceived = false,
  /** False when the origin said the page is gone (404 or 410): no live rung can bring it back, but the archive still can. */
  liveRungs = true,
): Promise<CrawlResult> {
  // Neither render rung gets the target's headers, so a credentialed target would render logged out and the login
  // page could replace the real one. Credentialed targets skip rendering.
  const rendered = credentialed || !liveRungs ? null : await renderFallback(url, config, options, started);
  if (rendered) {
    return withOriginMoved(rendered, priorDetail, rendered.ok && !rendered.notModified ? (rendered.pages[0]?.rung ?? 'render') : 'render', url);
  }

  // CRAWL-PROXY-1: the caller's own proxy comes before the third-party Jina rung
  // and never sees a credentialed target.
  if (!credentialed && liveRungs) {
    const viaProxy = await proxyFallback(url, config, options, started);
    if (viaProxy) return withOriginMoved(viaProxy, priorDetail, 'proxy', url);
  }

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
      ...(bodyReceived ? { bodyReceived: true } : {}),
    };
  }

  const viaJina: CrawlResult = liveRungs
    ? await jinaFallback(url, config, options, started, priorDetail)
    : { ok: false, reason: 'unreachable', detail: priorDetail, lane: 'own' };
  if (viaJina.ok) {
    // ORIGIN-MOVED-1: this rung stepped past a POLICY refusal, not a failed
    // fetch. Jina follows the same redirect from its own IPs, so a sold or
    // parked domain returns the new owner's content under the old URL — and
    // without this the caller sees an ordinary success. The refusal travels
    // with the page so a consumer can hold it for review.
    return withOriginMoved(viaJina, priorDetail, 'jina', url);
  }

  // BODY-RECEIVED-1 is attached HERE rather than inside each rung. A rung knows
  // whether IT got content; only the ladder knows whether the original fetch
  // did, and that is the fact a consumer needs to tell "the site is down" from
  // "the site served a shell".
  const withBodyFlag = (result: CrawlResult): CrawlResult =>
    result.ok || !bodyReceived ? result : { ...result, bodyReceived: true };

  // Last, and only for an explicitly permitted target — see archiveFallback.
  if (target?.robotsPolicy === 'allow') {
    const archived = await archiveFallback(url, config, options, started);
    // The archive capture is of the ORIGINAL url, so it is less wrong than a
    // live fetch of the new owner — but with archiveMaxAgeDays unset the
    // capture can post-date the sale, so it carries the flag too.
    if (archived) return withOriginMoved(archived, priorDetail, 'archive', url);
  }
  return withBodyFlag(viaJina);
}

/**
 * Render rung: our own browser service, for pages whose content only exists
 * after JavaScript runs. Returns null when no service is configured (skip to
 * the next rung) — a configured-but-broken service is reported as a failed usage
 * event, and the ladder then moves on.
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
    const localPage = await buildRungPage(config, options, {
      url,
      html: localHtml,
      contentType: 'text/html',
      etag: null,
      lastModified: null,
      baseHost: new URL(url).hostname,
      rung: 'local-render',
    });
    if (isQuarantined(localPage)) {
      emitUsage(config, { lane: 'own', rung: 'local-render', kind: 'render', url, ok: false, latencyMs: Date.now() - started, error: 'quarantined' });
      // QUARANTINE-TELEMETRY-1: every rung reports its own quarantine.
      const detail = 'Locally rendered content tripped the prompt-injection guard.';
      return quarantined(config, url, started, detail, localPage);
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

    const page = await buildRungPage(config, options, {
      url: rendered.url,
      html: rendered.html,
      contentType: rendered.contentType,
      etag: null,
      lastModified: null,
      baseHost: new URL(url).hostname,
      rung: 'browser-render',
    });

    if (isQuarantined(page)) {
      emitUsage(config, { lane: 'own', rung: 'browser-render', kind: 'render', url, ok: false, latencyMs: Date.now() - started, error: 'quarantined' });
      const detail = 'Rendered content tripped the prompt-injection guard.';
      return quarantined(config, url, started, detail, page);
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

/**
 * CRAWL-PROXY-1: retry a blocked page through the caller's `proxyFetch`.
 * Returns null whenever the rung does not apply or does not help, so the ladder moves on.
 */
async function proxyFallback(
  url: string,
  config: ResolvedConfig,
  options: CrawlOptions,
  started: number,
): Promise<CrawlResult | null> {
  if (!config.proxyFetch) return null;
  const fail = (error: string) =>
    emitUsage(config, { lane: 'own', rung: 'proxy', kind: 'fetch', url, ok: false, latencyMs: Date.now() - started, error });
  try {
    const requestUrl = new URL(url);
    const response = await fetchFollowingSafeRedirects(
      requestUrl,
      config,
      options.timeoutMs ?? config.defaults.timeoutMs,
      {},
      {},
      5,
      config.proxyFetch,
    );
    if (!response.ok) {
      fail(`HTTP ${response.status}`);
      return null;
    }
    const contentType = response.headers.get('content-type') || '';
    if (classifyContentType(contentType) !== 'html') {
      fail(`Unsupported content-type: ${contentType || 'unknown'}`);
      return null;
    }
    const page = await buildRungPage(config, options, {
      url: response.url || requestUrl.toString(),
      html: await readBodyCapped(response, config.limits.maxBodyBytes),
      contentType,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      baseHost: requestUrl.hostname,
      rung: 'proxy',
    });
    if (isQuarantined(page)) {
      fail('quarantined');
      const detail = 'Content fetched through the proxy tripped the prompt-injection guard.';
      return quarantined(config, url, started, detail, page);
    }
    if (!page.text.trim() || looksLikeBlockPage(page.text)) {
      fail('still blocked or empty');
      return null;
    }
    emitUsage(config, { lane: 'own', rung: 'proxy', kind: 'fetch', url, ok: true, latencyMs: Date.now() - started, costUsd: 0 });
    return { ok: true, pages: [page] };
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return null;
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
