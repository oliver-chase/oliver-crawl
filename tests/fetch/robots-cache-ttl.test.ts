import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createCrawler } from '@/index';
import { __clearRobotsCacheForTests, ROBOTS_CACHE_TTL_MS, ROBOTS_FAILURE_TTL_MS } from '@/lanes/own/index';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import type { CrawlTarget } from '@/core/types';

// ROBOTS-TTL-1: the robots cache had no expiry, so a long-lived process could
// (a) keep crawling a site that later added a Disallow, and (b) permanently
// stall a host on one transient failure. (b) is the one that actually bit
// Fallow — 125 sources fail-closed for four days.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
// robotsPolicy left unset so autoRobots has to resolve it for real.
const target: CrawlTarget = { baseUrl: 'https://venue.example.com', active: true };

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-27T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  __clearRobotsCacheForTests();
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
});

const html = () =>
  new Response(
    '<html><head><title>T</title></head><body><main><p>The summer concert series runs Friday evenings at the riverside stage.</p></main></body></html>',
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );

function stub(robots: () => Response) {
  const robotsHits = { count: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/robots.txt')) {
      robotsHits.count++;
      return robots();
    }
    return html();
  }) as typeof fetch;
  return robotsHits;
}

describe('a resolved robots posture is cached, but not forever', () => {
  test('within the TTL, robots.txt is fetched once across many pages', async () => {
    const hits = stub(() => new Response('User-agent: *\nAllow: /', { status: 200 }));
    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns, autoRobots: true });

    await crawler.crawl(target, 'https://venue.example.com/a');
    await crawler.crawl(target, 'https://venue.example.com/b');
    await crawler.crawl(target, 'https://venue.example.com/c');

    expect(hits.count).toBe(1);
  });

  test('a site that later adds a Disallow stops being crawled', async () => {
    let disallowed = false;
    const hits = stub(() =>
      disallowed
        ? new Response('User-agent: *\nDisallow: /', { status: 200 })
        : new Response('User-agent: *\nAllow: /', { status: 200 }),
    );
    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns, autoRobots: true });

    expect((await crawler.crawl(target, 'https://venue.example.com/a')).ok).toBe(true);

    // The operator adds a Disallow. Before this fix the cached 'allow' held
    // for the life of the process and we kept crawling over their refusal.
    disallowed = true;
    vi.setSystemTime(Date.now() + ROBOTS_CACHE_TTL_MS + 1000);

    const after = await crawler.crawl(target, 'https://venue.example.com/b');
    expect(after.ok).toBe(false);
    if (after.ok) throw new Error('crawled a disallowed site');
    expect(after.reason).toBe('blocked');
    expect(hits.count).toBe(2);
  });
});

describe('a failed robots fetch never becomes permanent', () => {
  test('a transient failure is retried, and the host recovers', async () => {
    let failing = true;
    const hits = stub(() => {
      if (failing) throw new Error('ECONNRESET');
      return new Response('User-agent: *\nAllow: /', { status: 200 });
    });
    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns, autoRobots: true });

    // Blip at startup: unknown posture, fails closed. Correct for now.
    const first = await crawler.crawl(target, 'https://venue.example.com/a');
    expect(first.ok).toBe(false);

    // Still inside the failure TTL — no point re-asking yet.
    await crawler.crawl(target, 'https://venue.example.com/b');
    expect(hits.count).toBe(1);

    // The blip passes. This is the case that stalled Fallow for four days:
    // without expiry the host would stay dead for the life of the process.
    failing = false;
    vi.setSystemTime(Date.now() + ROBOTS_FAILURE_TTL_MS + 1000);

    const recovered = await crawler.crawl(target, 'https://venue.example.com/c');
    expect(recovered.ok).toBe(true);
    expect(hits.count).toBe(2);
  });

  test('a failure is retried far sooner than a success is re-checked', () => {
    // The asymmetry is the point: holding a success is cheap, holding a
    // failure silently kills a host.
    expect(ROBOTS_FAILURE_TTL_MS).toBeLessThan(ROBOTS_CACHE_TTL_MS);
  });
});
