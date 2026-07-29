// ─── Jina Reader fallback: the last resort in the resolution loop ───────────
//
// Owner directive (scale): a site that blocks a direct crawl isn't
// dropped — the system self-diagnoses and falls back. The direct crawl fails
// on three real, common blockers:
//   1. the site moved and off-domain-redirects to a new host,
//   2. the host bot-walls the caller's / browser / Googlebot UAs by IP, and
//   3. the content is only there after JS runs.
// Jina Reader (https://r.jina.ai/<url>) clears all three at once, for free and
// with no API key: it follows redirects, renders the page, and fetches from
// ITS OWN IPs (so an IP/fingerprint bot-wall on the origin never sees the caller).
// Proven on Dillon Amphitheater — moved to dillonamp.com AND 403s every UA,
// yet Jina returns its rendered July 2026 event calendar.
//
// Used ONLY as a fallback (after the direct fetch fails), so a normal source's
// own richer, first-party HTML is always preferred and this third-party
// dependency is off the hot path. Returns null on any failure — callers treat
// null as "fallback did not help," never as empty content.

/**
 * JINA-SELFHOST-1: the endpoint is configurable.
 *
 * The public reader is free and keyless, which is why this rung exists — but
 * it is infrastructure we do not control, and a rate limit or an outage there
 * silently removes a rung from a ladder advertised as free. Jina publish an
 * Apache-2.0 self-hostable build (`ghcr.io/jina-ai/reader:oss`), so a consumer
 * who depends on this rung can run their own and point at it.
 *
 * Same shape as `browserRender`: ours by default, yours if you would rather
 * not depend on someone else's uptime.
 */
const JINA_ENDPOINT = 'https://r.jina.ai/';
const JINA_TIMEOUT_MS = 30_000;
const JINA_MAX_BYTES = 600_000;

export type JinaFetchResult = { title: string | null; text: string };

// The only host this module ever contacts is r.jina.ai; Jina fetches the
// target on its own server, so there is no SSRF surface here. The target URL
// is still required to be public https (it's the source's already-validated
// baseUrl at every call site).
export async function fetchViaJina(
  targetUrl: string,
  opts?: { fetchImpl?: typeof fetch; endpoint?: string; timeoutMs?: number },
): Promise<JinaFetchResult | null> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const endpoint = (opts?.endpoint || JINA_ENDPOINT).replace(/\/+$/, '');
  let target: URL;
  try {
    target = new URL(targetUrl);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return null;
  } catch {
    return null;
  }

  const controller = new AbortController();
  // TIMEOUT-JINA-1: honour the caller's budget. This rung ignored `timeoutMs`
  // entirely and used its own 30s, so a caller bounding a crawl at 8 seconds
  // still waited up to 30 here — the bound read as a guarantee and was not one.
  // A caller cannot see which rung is running, so the one number they set has
  // to mean something on every rung.
  //
  // The 30s stays as the DEFAULT, because this rung renders the page remotely
  // and is legitimately slower than a direct fetch; it is a ceiling for callers
  // who set nothing, not a floor that overrides them.
  const timeoutId = setTimeout(() => controller.abort(), opts?.timeoutMs ?? JINA_TIMEOUT_MS);
  try {
    const res = await doFetch(`${endpoint.replace(/\/+$/, '')}/${target.toString()}`, {
      method: 'GET',
      headers: {
        // Ask Jina for the readable content, not the raw DOM.
        'X-Return-Format': 'text',
        accept: 'text/plain',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.text()).slice(0, JINA_MAX_BYTES);
    return parseJinaResponse(body);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Jina prefixes its output with `Title:` / `URL Source:` / `Markdown Content:`
// lines. Split the title off and treat a Jina-reported upstream error
// ("Warning: Target URL returned error 404") as no content. Exported for tests.
export function parseJinaResponse(body: string): JinaFetchResult | null {
  const titleMatch = body.match(/^Title:\s*(.+)$/m);
  const title = titleMatch?.[1]?.trim() ?? null;

  // Jina reports the origin's own failure inline with a 200 — don't mistake it
  // for content.
  if (/Warning:\s*Target URL returned error \d{3}/i.test(body) || /^Title:\s*(File not found|Just a moment|Access denied|Attention Required)/im.test(body)) {
    return null;
  }

  const contentIdx = body.indexOf('Markdown Content:');
  const content = (contentIdx >= 0 ? body.slice(contentIdx + 'Markdown Content:'.length) : body).trim();
  // Too little to be a real page — treat as a miss so the caller doesn't route
  // a source to a dead fallback.
  if (content.replace(/\s+/g, ' ').trim().length < 200) return null;

  return { title, text: content };
}
