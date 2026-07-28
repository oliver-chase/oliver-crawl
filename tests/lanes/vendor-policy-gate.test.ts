import { afterEach, describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import { __clearRobotsCacheForTests } from '@/lanes/own/index';
import type { CrawlTarget } from '@/core/types';

// VENDOR-POLICY-1: governance is a property of the crawl, not of which
// network makes the request. Before this gate, `lanes: ['vendor']` ran with
// no vetting at all — paying Firecrawl to fetch what our own lane would have
// refused to touch.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
  __clearRobotsCacheForTests();
});

function vendorStub() {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('api.firecrawl.dev')) {
      return new Response(JSON.stringify({ data: { markdown: 'Paid content from the vendor.' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /', { status: 200 });
    return new Response('should not be fetched directly', { status: 500 });
  }) as typeof fetch;
  return calls;
}

const crawler = () =>
  createCrawler({
    userAgent: 'T/1',
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    vendor: { firecrawl: 'fc-key-long-enough' },
  });

describe('vendor-only crawls are still governed', () => {
  test('an off-domain URL is blocked before any vendor is paid', async () => {
    const calls = vendorStub();
    const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };

    const result = await crawler().crawl(target, 'https://evil.example.net/page', { lanes: ['vendor'] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected blocked');
    expect(result.reason).toBe('blocked');
    expect(calls.some((u) => u.includes('firecrawl'))).toBe(false);
  });

  test('unknown robots posture fails closed even with a paid key', async () => {
    const calls = vendorStub();
    const target: CrawlTarget = { baseUrl: 'https://venue.example.com', active: true };

    const result = await crawler().crawl(target, 'https://venue.example.com/events', { lanes: ['vendor'] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected blocked');
    expect(result.reason).toBe('blocked');
    expect(calls.some((u) => u.includes('firecrawl'))).toBe(false);
  });

  test('an inactive target is refused for the vendor lane too', async () => {
    const calls = vendorStub();
    const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: false };

    const result = await crawler().crawl(target, 'https://venue.example.com/events', { lanes: ['vendor'] });

    expect(result.ok).toBe(false);
    expect(calls.some((u) => u.includes('firecrawl'))).toBe(false);
  });

  test('a vetted same-site URL still reaches the vendor normally', async () => {
    const calls = vendorStub();
    const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };

    const result = await crawler().crawl(target, 'https://venue.example.com/events', { lanes: ['vendor'] });

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.lane).toBe('vendor');
    expect(calls.some((u) => u.includes('firecrawl'))).toBe(true);
  });

  test('autoRobots resolves an unknown posture before the vendor runs', async () => {
    const calls = vendorStub();
    const auto = createCrawler({
      userAgent: 'T/1',
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      autoRobots: true,
      vendor: { firecrawl: 'fc-key-long-enough' },
    });
    const target: CrawlTarget = { baseUrl: 'https://venue.example.com', active: true };

    const result = await auto.crawl(target, 'https://venue.example.com/events', { lanes: ['vendor'] });

    expect(result.ok).toBe(true);
    // robots.txt really was consulted, then the vendor ran.
    expect(calls.some((u) => u.endsWith('/robots.txt'))).toBe(true);
    expect(calls.some((u) => u.includes('firecrawl'))).toBe(true);
  });
});

describe('a vendor page carries markdown', () => {
  // Regression guard. The vendor rungs are asked for markdown explicitly, so
  // their text IS markdown and belongs in both fields. A refactor that routed
  // every text rung through one constructor silently dropped it, and nothing
  // caught that — markdown is the field callers are told to feed a model, so
  // the loss would have surfaced as worse extraction, not as an error.
  test('markdown is populated, not empty', async () => {
    vendorStub();
    const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };
    const result = await crawler().crawl(target, 'https://venue.example.com/events', { lanes: ['vendor'] });

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    const page = result.pages[0]!;
    expect(page.lane).toBe('vendor');
    expect(page.markdown).toBeTruthy();
    expect(page.markdown).toBe(page.text);
  });
});
