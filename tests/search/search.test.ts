import { afterEach, describe, expect, test, vi } from 'vitest';
import { search, availableSearchProviders } from '@/search/index';
import { resolveConfig } from '@/core/config';
import type { UsageEvent } from '@/core/types';

// Search is a separate surface from crawling — no target, no same-site rule,
// no page to guard. What it MUST get right: never claim "found nothing" when
// it actually never ran, never leak an unsafe URL from a provider, and never
// spend without the budget check.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const serperBody = (items: Array<{ title: string; snippet: string; link: string }>) =>
  new Response(JSON.stringify({ organic: items }), { status: 200, headers: { 'content-type': 'application/json' } });

const tavilyBody = (items: Array<{ title: string; content: string; url: string }>) =>
  new Response(JSON.stringify({ results: items }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('availableSearchProviders', () => {
  test('empty when no keys are set', () => {
    expect(availableSearchProviders(resolveConfig({ userAgent: 'T/1' }))).toEqual([]);
  });

  test('serper is tried before tavily by default (roughly 5x cheaper per call)', () => {
    const config = resolveConfig({ userAgent: 'T/1', vendor: { serper: 'serper-key-long', tavily: 'tavily-key-long' } });
    expect(availableSearchProviders(config)).toEqual(['serper', 'tavily']);
  });

  test('explicit order is respected', () => {
    const config = resolveConfig({
      userAgent: 'T/1',
      vendor: { serper: 'serper-key-long', tavily: 'tavily-key-long' },
      searchProviderOrder: ['tavily', 'serper'],
    });
    expect(availableSearchProviders(config)).toEqual(['tavily', 'serper']);
  });

  test('only configured providers are listed', () => {
    const config = resolveConfig({ userAgent: 'T/1', vendor: { tavily: 'tavily-key-long' } });
    expect(availableSearchProviders(config)).toEqual(['tavily']);
  });
});

describe('search — outcomes are distinguishable', () => {
  // The whole reason this returns an outcome rather than a bare array: a
  // caller cannot tell these three apart from an empty array.
  test('no key configured is reported as such, NOT as "no results"', async () => {
    const result = await search('anything', resolveConfig({ userAgent: 'T/1' }));
    expect(result).toMatchObject({ ok: false, reason: 'no_provider_configured' });
  });

  test('a genuine empty result set is reported as no_results', async () => {
    globalThis.fetch = (async () => serperBody([])) as typeof fetch;
    const config = resolveConfig({ userAgent: 'T/1', vendor: { serper: 'serper-key-long' } });
    const result = await search('nothing matches this', config);
    expect(result).toMatchObject({ ok: false, reason: 'no_results' });
  });

  test('a budget veto is reported as budget_refused and makes no call', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return serperBody([]);
    }) as typeof fetch;

    const config = resolveConfig({
      userAgent: 'T/1',
      vendor: { serper: 'serper-key-long' },
      checkBudget: () => false,
    });
    const result = await search('query', config);

    expect(result).toMatchObject({ ok: false, reason: 'budget_refused' });
    expect(called).toBe(false);
  });

  test('an empty query is rejected without calling a provider', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return serperBody([]);
    }) as typeof fetch;

    const config = resolveConfig({ userAgent: 'T/1', vendor: { serper: 'serper-key-long' } });
    const result = await search('   ', config);

    expect(result).toMatchObject({ ok: false, reason: 'error' });
    expect(called).toBe(false);
  });
});

describe('search — results', () => {
  test('returns normalised results and names the provider that served them', async () => {
    globalThis.fetch = (async () =>
      serperBody([{ title: 'Venue Events', snippet: 'Live music every Friday.', link: 'https://venue.example.com/events' }])) as typeof fetch;

    const config = resolveConfig({ userAgent: 'T/1', vendor: { serper: 'serper-key-long' } });
    const result = await search('venue events', config);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected results');
    expect(result.provider).toBe('serper');
    expect(result.results[0]).toEqual({
      title: 'Venue Events',
      snippet: 'Live music every Friday.',
      url: 'https://venue.example.com/events',
    });
  });

  // Results feed prompts and UIs — a javascript: href from a provider must
  // never survive to a caller.
  test('drops unsafe and private-host URLs', async () => {
    globalThis.fetch = (async () =>
      serperBody([
        { title: 'XSS', snippet: 'bad', link: 'javascript:alert(1)' },
        { title: 'Internal', snippet: 'bad', link: 'http://169.254.169.254/latest/meta-data/' },
        { title: 'Good', snippet: 'fine', link: 'https://venue.example.com/ok' },
      ])) as typeof fetch;

    const config = resolveConfig({ userAgent: 'T/1', vendor: { serper: 'serper-key-long' } });
    const result = await search('q', config);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected results');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.url).toBe('https://venue.example.com/ok');
  });

  test('deduplicates repeated URLs and respects maxResults', async () => {
    globalThis.fetch = (async () =>
      serperBody([
        { title: 'A', snippet: '1', link: 'https://a.example.com/' },
        { title: 'A again', snippet: '2', link: 'https://a.example.com/' },
        { title: 'B', snippet: '3', link: 'https://b.example.com/' },
        { title: 'C', snippet: '4', link: 'https://c.example.com/' },
      ])) as typeof fetch;

    const config = resolveConfig({ userAgent: 'T/1', vendor: { serper: 'serper-key-long' } });
    const result = await search('q', config, { maxResults: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected results');
    expect(result.results.map((r) => r.url)).toEqual(['https://a.example.com/', 'https://b.example.com/']);
  });

  test('truncates long snippets', async () => {
    globalThis.fetch = (async () =>
      serperBody([{ title: 'Long', snippet: 'x'.repeat(1000), link: 'https://a.example.com/' }])) as typeof fetch;

    const config = resolveConfig({ userAgent: 'T/1', vendor: { serper: 'serper-key-long' } });
    const result = await search('q', config);
    if (!result.ok) throw new Error('expected results');
    expect(result.results[0]!.snippet).toHaveLength(300);
  });
});

describe('search — provider fallback', () => {
  test('falls through to the next provider when the first errors', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('serper')) return new Response('down', { status: 500 });
      return tavilyBody([{ title: 'From Tavily', content: 'Second provider answered.', url: 'https://a.example.com/' }]);
    }) as typeof fetch;

    const events: UsageEvent[] = [];
    const config = resolveConfig({
      userAgent: 'T/1',
      vendor: { serper: 'serper-key-long', tavily: 'tavily-key-long' },
      onUsage: (e) => events.push(e),
    });
    const result = await search('q', config);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected results');
    expect(result.provider).toBe('tavily');
    // The failure is still reported, not swallowed.
    expect(events.some((e) => e.rung === 'serper' && !e.ok)).toBe(true);
  });

  test('falls through when the first provider returns nothing', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('serper')) return serperBody([]);
      return tavilyBody([{ title: 'Found', content: 'Tavily had it.', url: 'https://a.example.com/' }]);
    }) as typeof fetch;

    const config = resolveConfig({ userAgent: 'T/1', vendor: { serper: 'serper-key-long', tavily: 'tavily-key-long' } });
    const result = await search('q', config);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected results');
    expect(result.provider).toBe('tavily');
  });

  test('all providers failing reports no_results with the last detail', async () => {
    globalThis.fetch = (async () => new Response('down', { status: 503 })) as typeof fetch;
    const config = resolveConfig({ userAgent: 'T/1', vendor: { serper: 'serper-key-long', tavily: 'tavily-key-long' } });
    const result = await search('q', config);
    expect(result).toMatchObject({ ok: false, reason: 'no_results' });
    if (result.ok) throw new Error('expected failure');
    expect(result.detail).toMatch(/503/);
  });
});
