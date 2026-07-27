import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCrawler, crawlSite } from '@/index';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import type { CrawlTarget } from '@/core/types';

// The central promise: lane 1 works with NO keys, NO vendor accounts, and no
// path by which a vendor is called. Asserted rather than claimed, because it
// is the whole reason the package exists — and a future change that quietly
// made a vendor call reachable from the default path would break it silently.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };

const VENDOR_HOSTS = ['api.firecrawl.dev', 'api.apify.com', 'api.tavily.com', 'google.serper.dev'];

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
  vi.restoreAllMocks();
});

/** Fails loudly if anything reaches a paid vendor. */
function watchForVendorCalls() {
  const hits: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (VENDOR_HOSTS.some((h) => url.includes(h))) hits.push(url);
    if (url.includes('r.jina.ai')) return new Response('', { status: 500 });
    return new Response(
      '<html><head><title>Free</title></head><body><main><p>Read with no keys at all.</p>' +
        '<a href="/two">Two</a></main></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  }) as typeof fetch;
  return hits;
}

describe('lane 1 works with zero configuration', () => {
  test('a crawler built with ONLY a user agent can read a page', async () => {
    watchForVendorCalls();
    // No vendor keys. No browserRender. No env. Nothing but identity.
    const crawler = createCrawler({ userAgent: 'MyBot/1.0', dnsLookup: publicDns });

    const result = await crawler.crawl(target, 'https://venue.example.com/events');

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.text).toContain('Read with no keys at all.');
    expect(result.pages[0]!.lane).toBe('own');
  });

  test('reports no vendor rungs and no search providers when unconfigured', () => {
    const crawler = createCrawler({ userAgent: 'MyBot/1.0' });
    expect(crawler.vendorRungs()).toEqual([]);
    expect(crawler.searchProviders()).toEqual([]);
  });

  test('a whole-site crawl runs entirely on the free lane', async () => {
    const vendorHits = watchForVendorCalls();
    const crawler = createCrawler({ userAgent: 'MyBot/1.0', dnsLookup: publicDns });

    const run = await crawlSite(crawler, target, {
      seeds: ['https://venue.example.com/'],
      followLinks: true,
      maxPages: 3,
    });

    expect(run.pages.length).toBeGreaterThan(0);
    expect(run.pages.every((p) => p.lane === 'own')).toBe(true);
    expect(vendorHits).toEqual([]);
  });

  test('every free-lane feature is usable without a key', async () => {
    watchForVendorCalls();
    const crawler = createCrawler({
      userAgent: 'MyBot/1.0',
      dnsLookup: publicDns,
      // All free: pacing, caching, robots, limits. No vendor block at all.
      minHostIntervalMs: 1,
      adaptiveThrottleMultiplier: 2,
      cacheTtlMs: 1000,
      limits: { maxLinksPerPage: 50 },
    });

    const run = await crawlSite(crawler, target, {
      seeds: ['https://venue.example.com/'],
      followLinks: true,
      followPagination: true,
      maxPages: 2,
      maxDurationMs: 5000,
      politenessDelayMs: 1,
    });

    expect(run.pages.length).toBeGreaterThan(0);
    // Change-detection data is produced on the free lane too.
    const v = run.validators[run.pages[0]!.url];
    expect(v?.textSha256).toBeTruthy();
  });
});

describe('the paid lane cannot be reached by accident', () => {
  test('a vendor key present but not requested is never used', async () => {
    const vendorHits = watchForVendorCalls();
    const crawler = createCrawler({
      userAgent: 'MyBot/1.0',
      dnsLookup: publicDns,
      vendor: { firecrawl: 'fc-key-that-must-not-be-used', apify: 'apify-token-long' },
    });

    // No `lanes` option — the default must stay free-only.
    await crawler.crawl(target, 'https://venue.example.com/events');
    expect(vendorHits).toEqual([]);
  });

  test('asking for the vendor lane with no key fails instead of silently succeeding', async () => {
    watchForVendorCalls();
    const crawler = createCrawler({ userAgent: 'MyBot/1.0', dnsLookup: publicDns });

    const result = await crawler.crawl(target, 'https://venue.example.com/x', { lanes: ['vendor'] });
    expect(result).toMatchObject({ ok: false, reason: 'no_lane_available' });
  });

  test('search without a key reports why, and calls nothing', async () => {
    const vendorHits = watchForVendorCalls();
    const crawler = createCrawler({ userAgent: 'MyBot/1.0', dnsLookup: publicDns });

    const found = await crawler.search('anything');
    expect(found).toMatchObject({ ok: false, reason: 'no_provider_configured' });
    expect(vendorHits).toEqual([]);
  });
});
