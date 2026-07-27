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
import { isSafeHttpUrl } from '../core/url-safety.js';

export type SearchResult = {
  title: string;
  snippet: string;
  url: string;
};

export type SearchOutcome =
  | { ok: true; results: SearchResult[]; provider: string }
  | { ok: false; reason: 'no_provider_configured' | 'no_results' | 'budget_refused' | 'error'; detail: string };

const TAVILY_URL = 'https://api.tavily.com/search';
const SERPER_URL = 'https://google.serper.dev/search';
const SEARCH_TIMEOUT_MS = 10_000;
const MAX_SNIPPET_CHARS = 300;

export const DEFAULT_SEARCH_PROVIDER_ORDER = ['serper', 'tavily'];

type SearchProvider = {
  name: string;
  isConfigured: (config: ResolvedConfig) => boolean;
  run: (query: string, maxResults: number, config: ResolvedConfig) => Promise<SearchResult[]>;
};

/** Drop duplicate URLs and anything that is not a safe public http(s) URL —
 *  results feed prompts and UIs, so a `javascript:` href from a provider must
 *  never survive to a caller. */
function normalizeResults(raw: Array<{ title?: string; snippet?: string; url?: string }>, maxResults: number): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const item of raw) {
    const url = item.url || '';
    if (!url || seen.has(url) || !isSafeHttpUrl(url)) continue;
    seen.add(url);
    out.push({
      title: item.title || '',
      snippet: (item.snippet || '').slice(0, MAX_SNIPPET_CHARS),
      url,
    });
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
  options: { maxResults?: number } = {},
): Promise<SearchOutcome> {
  const maxResults = Math.max(1, options.maxResults ?? 3);
  const usable = availableSearchProviders(config);

  if (!query.trim()) {
    return { ok: false, reason: 'error', detail: 'Empty search query.' };
  }

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
      const results = await provider.run(query, maxResults, config);
      const latencyMs = Date.now() - started;

      if (results.length > 0) {
        emit(config, { lane: 'vendor', rung: name, kind: 'search', ok: true, latencyMs });
        return { ok: true, results, provider: name };
      }

      lastDetail = `${name} returned no results`;
      emit(config, { lane: 'vendor', rung: name, kind: 'search', ok: true, latencyMs });
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
      emit(config, { lane: 'vendor', rung: name, kind: 'search', ok: false, latencyMs: Date.now() - started, error: lastDetail });
      // Fall through to the next provider — one outage is not a dead end.
    }
  }

  return { ok: false, reason: 'no_results', detail: lastDetail };
}

function emit(config: ResolvedConfig, event: Parameters<NonNullable<ResolvedConfig['onUsage']>>[0]): void {
  try {
    config.onUsage?.(event);
  } catch {
    // a logging sink must never break a search
  }
}
