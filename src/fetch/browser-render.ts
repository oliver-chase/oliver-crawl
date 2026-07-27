// ─── Browser render rung (own lane) ─────────────────────────────────────────
//
// Renders a JS-only page through a browser service and returns its HTML.
//
// This sits in the OWN lane, not the vendor lane, on purpose: the endpoint is
// yours. Point it at a browserless/Playwright container you run and it costs
// no per-call vendor fee — which is exactly the distinction the two lanes
// encode (lane 1 = infrastructure you control, lane 2 = someone's API you are
// billed by). Nothing stops you pointing it at a paid rendering service
// instead; then it is a cost you have chosen and can see.
//
// Fully optional. No `browserRender` config means the rung is skipped and the
// crawl falls through to the free Jina fallback, exactly as if it did not
// exist. That is the same degrade-gracefully contract every other rung has.
//
// Ported from Fallow's secure-browser-runner.ts. Only the render call itself
// came over: that file's other ~400 lines are crawl orchestration coupled to
// its own source registry, which the lane already handles here.

import type { ResolvedConfig } from '../core/config.js';

const RENDER_TIMEOUT_MS = 30_000;

export type RenderResult = {
  url: string;
  status: number;
  html: string;
  contentType: string;
};

/** Validate the configured endpoint. https-only: the rendered HTML is fed
 *  straight into extraction, so a plaintext hop would let anyone on the path
 *  rewrite what the crawler believes a page said. */
export function renderServiceFrom(config: ResolvedConfig): { url: string; token: string } | null {
  const configured = config.browserRender;
  if (!configured?.url) return null;
  try {
    const parsed = new URL(configured.url);
    if (parsed.protocol !== 'https:') return null;
    return { url: configured.url.replace(/\/+$/, ''), token: configured.token ?? '' };
  } catch {
    return null;
  }
}

/**
 * Render one URL. Returns null when no service is configured — callers treat
 * that as "this rung is unavailable", never as an error.
 *
 * Throws only on a real service failure, so the caller can distinguish
 * "not configured" (null) from "configured but broken" (throw) and report
 * the second honestly rather than silently degrading.
 */
export async function renderViaService(targetUrl: string, config: ResolvedConfig): Promise<RenderResult | null> {
  const service = renderServiceFrom(config);
  if (!service) return null;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': config.userAgent,
  };
  if (service.token) headers.authorization = `Bearer ${service.token}`;

  const response = await fetch(service.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      url: targetUrl,
      options: { timeout: RENDER_TIMEOUT_MS, blockAds: true, waitUntil: 'domcontentloaded' },
    }),
    signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Browser render service HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as Partial<RenderResult> & { error?: string };
  if (data.error) throw new Error(`Browser render service error: ${data.error}`);
  if (!data.html) throw new Error('Browser render service returned no HTML');

  return {
    url: data.url || targetUrl,
    status: data.status ?? 200,
    html: data.html,
    contentType: data.contentType || 'text/html',
  };
}
