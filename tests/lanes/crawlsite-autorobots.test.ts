import { afterEach, describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { crawlSite } from '@/crawl-site';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import { __clearRobotsCacheForTests } from '@/lanes/own/index';
import type { CrawlTarget } from '@/core/types';

// CRAWLSITE-AUTOROBOTS-1, found by measuring whole-site coverage on live
// sources: crawlSite validated its seeds against the RAW target before the
// crawler could resolve robots, so with autoRobots on and no stored policy
// every seed failed closed and the run returned zero pages — while a
// single-page crawl of the same URL succeeded. No test caught it because
// every existing test sets robotsPolicy explicitly.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
// No robotsPolicy — the shape autoRobots exists to serve.
const target: CrawlTarget = { baseUrl: 'https://site.example.com', name: 'site' };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
  __clearRobotsCacheForTests();
});

function stub(robots = 'User-agent: *\nAllow: /') {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/robots.txt')) return new Response(robots, { status: 200 });
    const body =
      new URL(url).pathname === '/'
        ? '<p>The catalogue is open for browsing.</p><a href="/a">A</a><a href="/b">B</a>'
        : '<p>Product details, specifications and availability for this item.</p>';
    return new Response(`<html><head><title>T</title></head><body><main>${body}</main></body></html>`, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }) as typeof fetch;
}

describe('crawlSite honours autoRobots', () => {
  test('a target with no stored policy is crawled, not refused', async () => {
    stub();
    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns, autoRobots: true });
    const run = await crawlSite(crawler, target, { followLinks: true, maxDepth: 1, maxPages: 10 });

    expect(run.failures).toEqual([]);
    expect(run.pages.length).toBeGreaterThan(1);
  });

  test('it agrees with a single-page crawl of the same URL', async () => {
    // The symptom that exposed this: one path said allowed, the other refused.
    stub();
    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns, autoRobots: true });

    const single = await crawler.crawl(target, 'https://site.example.com/');
    const run = await crawlSite(crawler, target, { maxPages: 1 });

    expect(single.ok).toBe(true);
    expect(run.pages.length).toBe(1);
  });

  test('a real Disallow still fails closed', async () => {
    // autoRobots must resolve the posture, not assume permission.
    stub('User-agent: *\nDisallow: /');
    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns, autoRobots: true });
    const run = await crawlSite(crawler, target, { maxPages: 5 });

    expect(run.pages).toEqual([]);
    expect(run.failures.length).toBeGreaterThan(0);
  });

  test('without autoRobots an unknown policy still refuses', async () => {
    stub();
    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns });
    const run = await crawlSite(crawler, target, { maxPages: 5 });

    expect(run.pages).toEqual([]);
  });
});
