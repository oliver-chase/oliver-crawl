import { describe, expect, test, vi } from 'vitest';
import { createCrawler } from '@/index';
import type { CrawlTarget } from '@/core/types';
import { publicDns } from '../helpers';

// Cache, per-host throttle and single-page retry: the three efficiency and
// politeness gaps that existed once the crawler worked correctly.

const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };

const page = (body = 'Page content here.') =>
  new Response(`<html><head><title>T</title></head><body><main>${body}</main></body></html>`, {
    status: 200,
    headers: { 'content-type': 'text/html' },
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
  /** Starts the crawls under fake timers and returns the time each request reached the network. */
  async function fetchTimes(config: { minHostIntervalMs?: number }, targets: Array<[typeof target, string]>): Promise<number[]> {
    vi.useFakeTimers();
    const times: number[] = [];
    globalThis.fetch = (async () => {
      times.push(Date.now());
      return page();
    }) as typeof fetch;
    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns, ...config });
    const all = Promise.all(targets.map(([t, url]) => crawler.crawl(t, url)));
    await vi.advanceTimersByTimeAsync(2_000);
    await all;
    return times;
  }
  const sameHost: Array<[typeof target, string]> = ['a', 'b', 'c'].map((p) => [target, `https://venue.example.com/${p}`]);

  test('off by default — concurrent same-host requests are not delayed', async () => {
    const times = await fetchTimes({}, sameHost);
    expect(new Set(times).size).toBe(1);
  });

  // CONCURRENT callers must serialise, not all read the same "now" and fire together.
  test('concurrent same-host requests are spaced by minHostIntervalMs', async () => {
    const times = await fetchTimes({ minHostIntervalMs: 60 }, sameHost);
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(60);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(60);
  });

  test('different hosts never wait on each other', async () => {
    const times = await fetchTimes({ minHostIntervalMs: 200 }, [
      [{ baseUrl: 'https://a.example.com', robotsPolicy: 'allow' }, 'https://a.example.com/x'],
      [{ baseUrl: 'https://b.example.com', robotsPolicy: 'allow' }, 'https://b.example.com/x'],
    ]);
    expect(new Set(times).size).toBe(1);
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

describe('the page cache does not cross credentials or output options', () => {
  test('a page fetched with a credential is not served to a crawl without it', async () => {
    const seen: Array<string | null> = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>)?.authorization ?? null);
      return page();
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns, cacheTtlMs: 60_000 });
    const url = 'https://venue.example.com/members';
    await crawler.crawl({ ...target, headers: { authorization: 'Bearer test-token' } }, url);
    await crawler.crawl(target, url);
    expect(seen).toEqual(['Bearer test-token', null]);
  });

  test('a page cached without html is fetched again when html is requested', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return page();
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns, cacheTtlMs: 60_000 });
    await crawler.crawl(target, 'https://venue.example.com/x');
    const withHtml = await crawler.crawl(target, 'https://venue.example.com/x', { includeHtml: true });
    expect(calls).toBe(2);
    if (!withHtml.ok || withHtml.notModified) throw new Error('expected pages');
    expect(withHtml.pages[0]!.html).toBeTruthy();
  });
});
