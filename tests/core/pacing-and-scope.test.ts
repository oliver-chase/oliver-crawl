import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCrawler } from '@/index';
import { crawlSite } from '@/crawl-site';
import { intervalForHost, recordHostLatency, __clearThrottleForTests } from '@/core/host-throttle';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import type { CrawlTarget } from '@/core/types';

// Ideas adapted from established crawlers (Scrapy's AutoThrottle,
// LinkExtractor allow/deny, CLOSESPIDER_TIMEOUT), reimplemented to fit this
// package's model rather than ported.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };

const page = (body: string) =>
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

function crawler(extra = {}) {
  return createCrawler({ userAgent: 'T/1', dnsLookup: publicDns, ...extra });
}

describe('adaptive throttle', () => {
  test('off by default — the fixed interval is used verbatim', () => {
    recordHostLatency('slow.example.com', 3000);
    expect(intervalForHost('slow.example.com', 200)).toBe(200);
  });

  test('a slow host earns a longer gap', () => {
    recordHostLatency('slow.example.com', 2000);
    // 2000ms average x2 = 4000ms, well above the 200ms floor.
    expect(intervalForHost('slow.example.com', 200, 2)).toBeGreaterThan(3000);
  });

  test('a fast host is never polled faster than the configured floor', () => {
    recordHostLatency('fast.example.com', 20);
    // 20 x 2 = 40ms, but the floor is 500 — adaptive can only slow down.
    expect(intervalForHost('fast.example.com', 500, 2)).toBe(500);
  });

  test('an unseen host falls back to the fixed interval', () => {
    expect(intervalForHost('unknown.example.com', 250, 2)).toBe(250);
  });

  test('the average smooths rather than tracking one outlier', () => {
    for (let i = 0; i < 5; i++) recordHostLatency('h.example.com', 100);
    recordHostLatency('h.example.com', 5000); // one slow blip
    const interval = intervalForHost('h.example.com', 0, 1);
    // A naive last-value would give 5000; a smoothed average must be far less.
    expect(interval).toBeLessThan(2500);
    expect(interval).toBeGreaterThan(100);
  });
});

describe('include/exclude scoping', () => {
  const site = '<a href="/events/a">E</a><a href="/blog/b">B</a><a href="/shop/c">S</a>';

  test('includePatterns acts as an allowlist for DISCOVERED urls', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      page(String(input).includes('/events/') ? 'Event page.' : site)) as typeof fetch;

    const run = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/'],
      followLinks: true,
      includePatterns: [/\/events\//],
      maxPages: 10,
    });

    const urls = run.pages.map((p) => p.url);
    expect(urls).toContain('https://venue.example.com/events/a');
    expect(urls).not.toContain('https://venue.example.com/blog/b');
    expect(urls).not.toContain('https://venue.example.com/shop/c');
  });

  test('a seed is always crawled, even outside includePatterns', async () => {
    globalThis.fetch = (async () => page('Seed body.')) as typeof fetch;

    const run = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/about'],
      followLinks: true,
      includePatterns: [/\/events\//],
    });

    // You asked for it explicitly — the allowlist governs DISCOVERY.
    expect(run.pages).toHaveLength(1);
    expect(run.pages[0]!.url).toContain('/about');
  });

  test('exclude wins over include when both match', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      page(String(input).endsWith('/') ? '<a href="/events/private">P</a>' : 'Body.')) as typeof fetch;

    const run = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/'],
      followLinks: true,
      includePatterns: [/\/events\//],
      excludePatterns: [/private/],
      maxPages: 10,
    });

    expect(run.pages.map((p) => p.url)).not.toContain('https://venue.example.com/events/private');
  });
});

describe('total run time budget', () => {
  test('stops cleanly at maxDurationMs and keeps what it gathered', async () => {
    globalThis.fetch = (async () => {
      await new Promise((r) => setTimeout(r, 60));
      return page('Slow page.');
    }) as typeof fetch;

    const seeds = Array.from({ length: 20 }, (_, i) => `https://venue.example.com/p/${i}`);
    const started = Date.now();
    const run = await crawlSite(crawler(), target, { seeds, maxPages: 20, maxDurationMs: 200 });
    const elapsed = Date.now() - started;

    // A page budget alone would have run all 20 (~1.2s).
    expect(elapsed).toBeLessThan(900);
    expect(run.truncated).toBe(true);
    expect(run.pages.length).toBeGreaterThan(0);
    expect(run.pages.length).toBeLessThan(20);
  });

  test('a run that finishes inside the budget is not marked truncated', async () => {
    globalThis.fetch = (async () => page('Fast page.')) as typeof fetch;
    const run = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/x'],
      maxDurationMs: 10_000,
    });
    expect(run.truncated).toBe(false);
  });
});
