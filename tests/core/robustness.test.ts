import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCrawler, searchAndCrawl } from '@/index';
import { charsetFromContentType, charsetFromMetaTag, decodeBody } from '@/core/charset';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import type { CrawlTarget } from '@/core/types';

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
  vi.restoreAllMocks();
});

describe('character encoding', () => {
  test('reads the charset from Content-Type', () => {
    expect(charsetFromContentType('text/html; charset=ISO-8859-1')).toBe('iso-8859-1');
    expect(charsetFromContentType('text/html; charset="windows-1252"')).toBe('windows-1252');
    expect(charsetFromContentType('text/html')).toBeNull();
    expect(charsetFromContentType(null)).toBeNull();
  });

  test('falls back to a meta charset declaration', () => {
    const html = new TextEncoder().encode('<html><head><meta charset="windows-1252"></head><body>x</body></html>');
    expect(charsetFromMetaTag(html)).toBe('windows-1252');
  });

  // The actual bug: a UTF-8 assumption silently mangles a latin-1 page, and
  // the corrupted text flows into the database and the LLM looking normal.
  test('decodes windows-1252 correctly instead of mangling it', () => {
    // 0xE9 is 'é' in windows-1252, invalid as standalone UTF-8.
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café"
    expect(decodeBody(bytes, 'text/html; charset=windows-1252')).toBe('café');
    // Proof the naive assumption really does corrupt it:
    expect(new TextDecoder().decode(bytes)).not.toBe('café');
  });

  test('an unknown charset label degrades to utf-8 rather than throwing', () => {
    const bytes = new TextEncoder().encode('hello');
    expect(decodeBody(bytes, 'text/html; charset=not-a-real-charset')).toBe('hello');
  });

  test('end to end: a latin-1 page comes back with correct characters', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<html><head><title>T</title></head><body><main>Caf'),
      0xe9,
      ...new TextEncoder().encode(' du Nord concert listing</main></body></html>'),
    ]);
    globalThis.fetch = (async () =>
      new Response(bytes, { status: 200, headers: { 'content-type': 'text/html; charset=windows-1252' } })) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://venue.example.com/x');

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.text).toContain('Café du Nord');
  });
});

describe('Retry-After compliance', () => {
  test('surfaces the origin-requested wait on a 429', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('r.jina.ai')) return new Response('', { status: 500 });
      return new Response('slow down', { status: 429, headers: { 'retry-after': '30' } });
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://venue.example.com/x');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.retryAfterMs).toBe(30_000);
    expect(result.detail).toMatch(/wait 30s/);
  });

  test('accepts the HTTP-date form too', async () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('r.jina.ai')) return new Response('', { status: 500 });
      return new Response('slow down', { status: 503, headers: { 'retry-after': future } });
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://venue.example.com/x');
    if (result.ok) throw new Error('expected failure');
    expect(result.retryAfterMs).toBeGreaterThan(40_000);
  });

  test('an absurd Retry-After is capped, not obeyed literally', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('r.jina.ai')) return new Response('', { status: 500 });
      return new Response('go away', { status: 429, headers: { 'retry-after': '86400' } });
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://venue.example.com/x');
    if (result.ok) throw new Error('expected failure');
    // Capped at 5 minutes — a crawl run must not hang for a day.
    expect(result.retryAfterMs).toBe(300_000);
  });
});

describe('per-target auth headers', () => {
  test('sends caller-supplied headers to that target', async () => {
    let seen: Record<string, string> = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      );
      return new Response('<html><body><main>Members-only listing.</main></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });
    const result = await crawler.crawl(
      { ...target, headers: { authorization: 'Bearer my-token', cookie: 'session=abc' } },
      'https://venue.example.com/members',
    );

    expect(result.ok).toBe(true);
    expect(seen.authorization).toBe('Bearer my-token');
    expect(seen.cookie).toBe('session=abc');
  });

  test('reserved headers cannot be overridden by a target', async () => {
    let seen: Record<string, string> = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      );
      return new Response('<html><body><main>x y z</main></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'RealBot/1.0', dnsLookup: publicDns });
    await crawler.crawl(
      { ...target, headers: { 'user-agent': 'SpoofedBot/9', host: 'evil.example.net' } },
      'https://venue.example.com/x',
    );

    expect(seen['user-agent']).toBe('RealBot/1.0');
    expect(seen.host).toBeUndefined();
  });
});

describe('searchAndCrawl', () => {
  const serper = (links: string[]) =>
    new Response(
      JSON.stringify({ organic: links.map((l, i) => ({ title: `R${i}`, snippet: 's', link: l })) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  test('searches, then reads each result through the normal guards', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('serper')) return serper(['https://a.example.com/page']);
      return new Response('<html><head><title>A</title></head><body><main>Result page body.</main></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;

    const crawler = createCrawler({
      userAgent: 'T/1',
      dnsLookup: publicDns,
      vendor: { serper: 'serper-key-long' },
      autoRobots: false,
    });
    // robotsPolicy is unset on search results, so they fail closed unless
    // autoRobots is on — a search hit is not permission to crawl a stranger.
    const found = await searchAndCrawl(crawler, 'test query');

    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error('expected ok');
    expect(found.results).toHaveLength(1);
    expect(found.skipped[0]!.reason).toBe('blocked');
  });

  test('searchOnly skips crawling entirely', async () => {
    let crawled = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('serper')) return serper(['https://a.example.com/page']);
      crawled = true;
      return new Response('<html><body>x</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns, vendor: { serper: 'serper-key-long' } });
    const found = await searchAndCrawl(crawler, 'q', { searchOnly: true });

    expect(found.ok).toBe(true);
    expect(crawled).toBe(false);
  });

  test('a failed search is reported, not silently empty', async () => {
    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });
    const found = await searchAndCrawl(crawler, 'q');
    expect(found).toMatchObject({ ok: false, reason: 'no_provider_configured' });
  });

  test('site: restriction is applied to the query sent to the provider', async () => {
    let sentQuery = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('serper')) {
        sentQuery = JSON.parse(String(init?.body)).q;
        return serper([]);
      }
      return new Response('x', { status: 404 });
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns, vendor: { serper: 'serper-key-long' } });
    await crawler.search('concerts', { site: 'https://venue.example.com/events' });

    expect(sentQuery).toBe('site:venue.example.com concerts');
  });
});
