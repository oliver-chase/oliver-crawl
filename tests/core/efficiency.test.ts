import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCrawler } from '@/index';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import type { CrawlTarget } from '@/core/types';

// Cache, per-host throttle and single-page retry: the three efficiency and
// politeness gaps that existed once the crawler worked correctly.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };

const page = (body = 'Page content here.') =>
  new Response(`<html><head><title>T</title></head><body><main>${body}</main></body></html>`, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
  vi.restoreAllMocks();
});

describe('page cache', () => {
  test('off by default — a repeat fetch really refetches', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return page();
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });
    await crawler.crawl(target, 'https://venue.example.com/x');
    await crawler.crawl(target, 'https://venue.example.com/x');
    expect(calls).toBe(2);
  });

  test('with a TTL, the second fetch is served from cache', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return page();
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns, cacheTtlMs: 60_000 });
    const a = await crawler.crawl(target, 'https://venue.example.com/x');
    const b = await crawler.crawl(target, 'https://venue.example.com/x');

    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  test('failures are never cached — they must stay retryable', async () => {
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('r.jina.ai')) return new Response('', { status: 500 });
      calls++;
      return new Response('down', { status: 503 });
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns, cacheTtlMs: 60_000 });
    await crawler.crawl(target, 'https://venue.example.com/x');
    await crawler.crawl(target, 'https://venue.example.com/x');
    expect(calls).toBe(2);
  });

  test('a different lane set is a different cache entry', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return page();
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns, cacheTtlMs: 60_000 });
    await crawler.crawl(target, 'https://venue.example.com/x', { lanes: ['own'] });
    await crawler.crawl(target, 'https://venue.example.com/x', { lanes: ['own', 'vendor'] });
    expect(calls).toBe(2);
  });
});

describe('per-host throttle', () => {
  test('off by default — concurrent same-host requests are not delayed', async () => {
    globalThis.fetch = (async () => page()) as typeof fetch;
    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });

    const started = Date.now();
    await Promise.all([
      crawler.crawl(target, 'https://venue.example.com/a'),
      crawler.crawl(target, 'https://venue.example.com/b'),
      crawler.crawl(target, 'https://venue.example.com/c'),
    ]);
    expect(Date.now() - started).toBeLessThan(200);
  });

  // The real point: CONCURRENT callers must serialise, not all read the same
  // "now" and fire together — the bug a naive last-request-time check has.
  test('concurrent same-host requests are spaced by minHostIntervalMs', async () => {
    globalThis.fetch = (async () => page()) as typeof fetch;
    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns, minHostIntervalMs: 60 });

    const started = Date.now();
    await Promise.all([
      crawler.crawl(target, 'https://venue.example.com/a'),
      crawler.crawl(target, 'https://venue.example.com/b'),
      crawler.crawl(target, 'https://venue.example.com/c'),
    ]);
    // 3 requests at a 60ms gap: the 3rd waits ~120ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  test('different hosts never wait on each other', async () => {
    globalThis.fetch = (async () => page()) as typeof fetch;
    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns, minHostIntervalMs: 200 });

    const started = Date.now();
    await Promise.all([
      crawler.crawl({ baseUrl: 'https://a.example.com', robotsPolicy: 'allow' }, 'https://a.example.com/x'),
      crawler.crawl({ baseUrl: 'https://b.example.com', robotsPolicy: 'allow' }, 'https://b.example.com/x'),
    ]);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('single-page retry', () => {
  test('no retry by default', async () => {
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('r.jina.ai')) return new Response('', { status: 500 });
      calls++;
      return new Response('down', { status: 503 });
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });
    await crawler.crawl(target, 'https://venue.example.com/x');
    expect(calls).toBe(1);
  });

  test('retries a transient failure when asked', async () => {
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('r.jina.ai')) return new Response('', { status: 500 });
      calls++;
      if (calls === 1) return new Response('down', { status: 503 });
      return page('Recovered.');
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://venue.example.com/x', { retries: 1 });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  test('a policy refusal is never retried, whatever the setting', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return page();
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });
    await crawler.crawl(target, 'https://elsewhere.example.net/x', { retries: 5 });
    expect(calls).toBe(0);
  });
});
