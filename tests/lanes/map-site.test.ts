import { afterEach, describe, expect, test } from 'vitest';
import { createCrawler, mapSite } from '@/index';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import type { CrawlTarget } from '@/core/types';

// PARITY-MAP-1: "what pages does this site have" should cost about one
// request, not a full crawl that fetches every page to find the next.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };

const SITEMAP = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  '  <url><loc>https://venue.example.com/a</loc></url>',
  '  <url><loc>https://venue.example.com/b</loc></url>',
  '</urlset>',
].join('\n');

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
});

function stub(opts: { sitemap?: boolean } = {}) {
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url.endsWith('/sitemap.xml')) {
      if (opts.sitemap === false) return new Response('nope', { status: 404 });
      return new Response(SITEMAP, { status: 200, headers: { 'content-type': 'application/xml' } });
    }
    return new Response(
      `<html><head><title>Home</title></head><body><main>
         <p>Welcome to the riverside venue and its summer concert series.</p>
         <a href="/calendar">Calendar</a>
         <a href="/menu">Menu</a>
         <a href="/events.ics">Subscribe</a>
         <a href="/feed">RSS</a>
         <a href="/a">Also A</a>
         <a href="/a/">A again</a>
       </main></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }) as typeof fetch;
  return fetched;
}

const crawler = () => createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns });

describe('mapSite finds URLs cheaply', () => {
  test('combines sitemap and homepage links', async () => {
    stub();
    const map = await mapSite(crawler(), target);

    expect(map.urls).toContain('https://venue.example.com/a');
    expect(map.urls).toContain('https://venue.example.com/b');
    expect(map.urls).toContain('https://venue.example.com/calendar');
    expect(map.urls).toContain('https://venue.example.com/menu');
    expect(map.sources.sitemap).toBe(2);
    expect(map.sources.homepageLinks).toBeGreaterThan(0);
  });

  test('fetches ONE page body — the homepage', async () => {
    const fetched = stub();
    await mapSite(crawler(), target);

    // Everything else is a listing document, not a page body. A crawl would
    // have fetched /calendar, /menu and the rest to discover their links.
    const pageBodies = fetched.filter((u) => !u.endsWith('/sitemap.xml'));
    expect(pageBodies).toEqual(['https://venue.example.com/']);
  });

  test('surfaces feeds separately — usually the best targets on a site', async () => {
    stub();
    const map = await mapSite(crawler(), target);
    expect(map.feeds).toContain('https://venue.example.com/events.ics');
    expect(map.feeds).toContain('https://venue.example.com/feed');
  });

  test('dedups /a and /a/ into one slot', async () => {
    stub();
    const map = await mapSite(crawler(), target);
    const aVariants = map.urls.filter((u) => /\/a\/?$/.test(u));
    expect(aVariants).toHaveLength(1);
  });
});

describe('mapSite degrades gracefully', () => {
  test('no sitemap still yields the homepage links', async () => {
    stub({ sitemap: false });
    const map = await mapSite(crawler(), target);

    expect(map.sources.sitemap).toBe(0);
    expect(map.urls).toContain('https://venue.example.com/calendar');
  });

  test('a homepage that will not load still returns the sitemap', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/sitemap.xml')) {
        return new Response(SITEMAP, { status: 200, headers: { 'content-type': 'application/xml' } });
      }
      return new Response('down', { status: 500 });
    }) as typeof fetch;

    const map = await mapSite(crawler(), target);
    expect(map.urls).toContain('https://venue.example.com/a');
    expect(map.sources.homepageLinks).toBe(0);
  });

  test('maxUrls caps the result and reports truncation', async () => {
    stub();
    const map = await mapSite(crawler(), target, { maxUrls: 2 });
    expect(map.urls).toHaveLength(2);
    expect(map.truncated).toBe(true);
  });

  test('sitemapOnly skips the homepage fetch entirely', async () => {
    const fetched = stub();
    const map = await mapSite(crawler(), target, { sitemapOnly: true });

    expect(fetched.every((u) => u.endsWith('/sitemap.xml'))).toBe(true);
    expect(map.urls).toHaveLength(2);
  });
});
