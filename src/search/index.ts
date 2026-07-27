// ─── Search ─────────────────────────────────────────────────────────────────
//
// A DIFFERENT SHAPE from crawling, and kept deliberately separate rather than
// bolted on as a third lane: crawling is "here is a URL, read it"; search is
// "here is a question, find URLs". They share config, budgeting and usage
// reporting, but nothing else — a search provider has no target, no same-site
// rule, no robots posture, and no page to guard.
//
// Every provider is paid, so unlike the own crawl lane there is no free rung
// here: no key means no search, reported honestly rather than silently
// returning nothing (a caller cannot tell "found nothing" from "never ran"
// unless we say which).
//
// Providers are tried IN ORDER until one returns results — the same
// degrade-gracefully contract as the vendor crawl lane. Serper is the default
// first rung because it is roughly 5x cheaper per call than Tavily for the
// same corroboration job (measured in the origin repo, where search was 73%
// of all external spend), and it returns Google results, which is usually
// what a corroboration query actually wants.

import type { ResolvedConfig } from '../core/config.js';
import { emitUsage } from '../core/usage.js';
import { isSafeHttpUrl } from '../core/url-safety.js';
import { sanitizeCrawledText } from '../guard/prompt-injection-guard.js';

export type SearchResult = {
  title: string;
  snippet: string;
  url: string;
  /**
   * True when the provider's title/snippet contained prompt-injection signals
   * and was withheld. The `url` is still returned and still safe to crawl —
   * only the provider-supplied prose was dropped.
   *
   * Worth surfacing rather than hiding: a result whose own meta description
   * is an injection payload is a strong hint about the page behind it.
   */
  injectionFiltered?: boolean;
};

export type SearchOutcome =
  | { ok: true; results: SearchResult[]; provider: string }
  | { ok: false; reason: 'no_provider_configured' | 'no_results' | 'budget_refused' | 'error'; detail: string };

const TAVILY_URL = 'https://api.tavily.com/search';
const SERPER_URL = 'https://google.serper.dev/search';
const SEARCH_TIMEOUT_MS = 10_000;
const MAX_SNIPPET_CHARS = 300;

export const DEFAULT_SEARCH_PROVIDER_ORDER = ['serper', 'tavily'];

export type SearchOptions = {
  maxResults?: number;
  /** Restrict results to one site. Accepts a bare host or a full URL. */
  site?: string;
};

/** Accept 'example.com', 'https://example.com/x' or 'www.example.com' and
 *  produce the bare host a `site:` operator expects. */
function normaliseSiteOperand(site: string): string {
  const trimmed = site.trim();
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return trimmed;
  }
}

type SearchProvider = {
  name: string;
  isConfigured: (config: ResolvedConfig) => boolean;
  run: (query: string, maxResults: number, config: ResolvedConfig) => Promise<SearchResult[]>;
};

/**
 * Normalise provider output across the trust boundary.
 *
 * A search provider is UNTRUSTED in two separate ways, and both have to be
 * handled here because this is the only place every provider's output passes
 * through:
 *
 *   1. The `url` may not be a safe public http(s) URL. A `javascript:` href
 *      reaching a caller's UI is an XSS; a private-network URL reaching the
 *      fetcher is an SSRF.
 *   2. SEARCH-INJECTION-1 (2026-07-27, found in audit): `title` and `snippet`
 *      are attacker-influenceable prose — a snippet is usually just the target
 *      page's own meta description. Crawled page text has always gone through
 *      the injection guard, but these did not, so the identical payload was
 *      blocked when we fetched the page and waved through when a search engine
 *      quoted it. These strings are documented as feeding prompts, which makes
 *      that the shorter path to the model, not the longer one.
 *
 * A tripped snippet drops the prose but KEEPS the url: the url is separately
 * validated and still useful, and throwing away a real result because its meta
 * description was hostile would cost accuracy for no security gain.
 */
function normalizeResults(raw: Array<{ title?: string; snippet?: string; url?: string }>, maxResults: number): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const item of raw) {
    const url = item.url || '';
    if (!url || seen.has(url) || !isSafeHttpUrl(url)) continue;
    seen.add(url);

    const title = item.title || '';
    const snippet = (item.snippet || '').slice(0, MAX_SNIPPET_CHARS);
    // Guarded together: an injection split across the two fields would pass a
    // check that only ever saw them apart.
    const checked = sanitizeCrawledText(`${title}\n${snippet}`, MAX_SNIPPET_CHARS * 2);

    out.push(
      checked.signals.length > 0
        ? { title: '', snippet: '', url, injectionFiltered: true }
        : { title, snippet, url },
    );
    if (out.length >= maxResults) break;
  }
  return out;
}

const tavily: SearchProvider = {
  name: 'tavily',
  isConfigured: (config) => Boolean(config.vendor?.tavily),
  async run(query, maxResults, config) {
    const response = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.vendor?.tavily}` },
      body: JSON.stringify({ query, search_depth: 'basic', max_results: maxResults, include_answer: false }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Tavily HTTP ${response.status}`);
    const data = (await response.json()) as { results?: Array<{ title?: string; content?: string; url?: string }> };
    return normalizeResults(
      (data.results || []).map((r) => ({ title: r.title, snippet: r.content, url: r.url })),
      maxResults,
    );
  },
};

const serper: SearchProvider = {
  name: 'serper',
  isConfigured: (config) => Boolean(config.vendor?.serper),
  async run(query, maxResults, config) {
    const response = await fetch(SERPER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': config.vendor?.serper ?? '' },
      body: JSON.stringify({ q: query, num: maxResults }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Serper HTTP ${response.status}`);
    const data = (await response.json()) as { organic?: Array<{ title?: string; snippet?: string; link?: string }> };
    return normalizeResults(
      (data.organic || []).map((r) => ({ title: r.title, snippet: r.snippet, url: r.link })),
      maxResults,
    );
  },
};

const PROVIDERS: Record<string, SearchProvider> = { tavily, serper };

/** Which search providers are usable with the current keys. */
export function availableSearchProviders(config: ResolvedConfig): string[] {
  const order = config.searchProviderOrder ?? DEFAULT_SEARCH_PROVIDER_ORDER;
  return order.filter((name) => PROVIDERS[name]?.isConfigured(config));
}

/**
 * Search the web, trying configured providers in order until one returns
 * results.
 *
 * Reports WHY it came back empty rather than returning a bare array: a caller
 * building on this needs to distinguish "the web has nothing" from "you never
 * configured a key" or "your budget check said no", and an empty array
 * collapses all three into the same answer.
 */
export async function search(
  query: string,
  config: ResolvedConfig,
  options: SearchOptions = {},
): Promise<SearchOutcome> {
  const maxResults = Math.max(1, options.maxResults ?? 3);
  const usable = availableSearchProviders(config);

  if (!query.trim()) {
    return { ok: false, reason: 'error', detail: 'Empty search query.' };
  }

  // Both providers speak Google's `site:` operator. Restricting a query to a
  // domain is the difference between "search the web about this venue" and
  // "find pages ON this venue's site" — the second is what a crawler usually
  // actually wants, and doing it by hand is easy to get subtly wrong.
  const effectiveQuery = options.site ? `site:${normaliseSiteOperand(options.site)} ${query}`.trim() : query;

  if (usable.length === 0) {
    return {
      ok: false,
      reason: 'no_provider_configured',
      detail: 'No search provider is configured. Set SERPER_API_KEY or TAVILY_API_KEY.',
    };
  }

  let lastDetail = 'no provider returned results';

  for (const name of usable) {
    const provider = PROVIDERS[name];
    if (!provider) continue;

    // Every search provider is paid — always budget-gated.
    if (config.checkBudget) {
      const allowed = await config.checkBudget();
      if (!allowed) return { ok: false, reason: 'budget_refused', detail: 'Budget check refused the search call.' };
    }

    const started = Date.now();
    try {
      const results = await provider.run(effectiveQuery, maxResults, config);
      const latencyMs = Date.now() - started;

      if (results.length > 0) {
        emitUsage(config, { lane: 'vendor', rung: name, kind: 'search', ok: true, latencyMs });
        return { ok: true, results, provider: name };
      }

      lastDetail = `${name} returned no results`;
      emitUsage(config, { lane: 'vendor', rung: name, kind: 'search', ok: true, latencyMs });
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
      emitUsage(config, { lane: 'vendor', rung: name, kind: 'search', ok: false, latencyMs: Date.now() - started, error: lastDetail });
      // Fall through to the next provider — one outage is not a dead end.
    }
  }

  return { ok: false, reason: 'no_results', detail: lastDetail };
}

