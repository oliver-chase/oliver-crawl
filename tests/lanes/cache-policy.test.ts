import { afterEach, describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import { __clearRobotsCacheForTests } from '@/lanes/own/index';
import type { CrawlTarget } from '@/core/types';

// CACHE-POLICY-1: the page cache is keyed on (url, lanes) — NOT on the
// target. If a cache hit is served before policy runs, a second target can
// read a page it was never allowed to fetch.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
  __clearRobotsCacheForTests();
});

const html = () =>
  new Response(
    '<html><head><title>T</title></head><body><main><p>Concerts every Friday evening at the riverside stage.</p></main></body></html>',
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );

const crawler = () =>
  createCrawler({
    userAgent: 'T/1',
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    cacheTtlMs: 60_000,
  });

describe('a cached page never escapes the policy gate', () => {
  test('a second, off-domain target cannot read a cached page', async () => {
    globalThis.fetch = (async () => html()) as typeof fetch;
    const c = crawler();

    const allowed: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };
    const first = await c.crawl(allowed, 'https://venue.example.com/events');
    expect(first.ok).toBe(true);

    // Different target, same URL. This URL is off-domain for it, so it must
    // be refused — the cache must not hand over what policy would block.
    const other: CrawlTarget = { baseUrl: 'https://other.example.org', robotsPolicy: 'allow', active: true };
    const second = await c.crawl(other, 'https://venue.example.com/events');

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('cache served an off-domain page');
    expect(second.reason).toBe('blocked');
  });

  test('a target turned inactive stops reading its own cached page', async () => {
    globalThis.fetch = (async () => html()) as typeof fetch;
    const c = crawler();

    const live: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };
    expect((await c.crawl(live, 'https://venue.example.com/events')).ok).toBe(true);

    const paused: CrawlTarget = { ...live, active: false };
    const after = await c.crawl(paused, 'https://venue.example.com/events');
    expect(after.ok).toBe(false);
  });

  test('the cache still works for a legitimately repeated crawl', async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return html();
    }) as typeof fetch;
    const c = crawler();
    const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };

    await c.crawl(target, 'https://venue.example.com/events');
    await c.crawl(target, 'https://venue.example.com/events');

    expect(fetches).toBe(1);
  });
});
