import { afterEach, describe, expect, test, vi } from 'vitest';
import { discoverSitemapUrls } from '@/fetch/sitemap-discovery';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import type { CrawlTarget } from '@/core/types';

// Sitemap discovery: the free "what pages does this site have" answer. What
// must hold: same-site filtering on everything (a sitemap is origin-
// controlled content), index files followed one level, no-sitemap is a
// normal condition, and caps are real.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

const target: CrawlTarget = {
  name: 'Venue',
  baseUrl: 'https://venue.example.com',
  robotsPolicy: 'allow',
  active: true,
};

const xml = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  vi.restoreAllMocks();
});

describe('discoverSitemapUrls', () => {
  test('reads a flat sitemap and returns same-site URLs', async () => {
    globalThis.fetch = (async () =>
      xml(`<?xml version="1.0"?><urlset>
        <url><loc>https://venue.example.com/events</loc></url>
        <url><loc>https://venue.example.com/events/summer-fest</loc></url>
      </urlset>`)) as typeof fetch;

    const result = await discoverSitemapUrls(target, { userAgent: 'T/1', dnsLookup: publicDns });
    expect(result.urls).toEqual(['https://venue.example.com/events', 'https://venue.example.com/events/summer-fest']);
    expect(result.truncated).toBe(false);
  });

  test('drops off-site and unsafe entries — a sitemap gets no extra trust', async () => {
    globalThis.fetch = (async () =>
      xml(`<urlset>
        <url><loc>https://venue.example.com/ok</loc></url>
        <url><loc>https://evil.example.net/injected</loc></url>
        <url><loc>http://venue.example.com/plaintext</loc></url>
      </urlset>`)) as typeof fetch;

    const result = await discoverSitemapUrls(target, { userAgent: 'T/1', dnsLookup: publicDns });
    expect(result.urls).toEqual(['https://venue.example.com/ok']);
  });

  test('follows a sitemap index one level, same-site children only', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/sitemap.xml')) {
        return xml(`<sitemapindex>
          <sitemap><loc>https://venue.example.com/sitemap-events.xml</loc></sitemap>
          <sitemap><loc>https://evil.example.net/sitemap.xml</loc></sitemap>
        </sitemapindex>`);
      }
      if (url.endsWith('/sitemap-events.xml')) {
        return xml('<urlset><url><loc>https://venue.example.com/events/a</loc></url></urlset>');
      }
      return new Response('should not fetch this', { status: 500 });
    }) as typeof fetch;

    const result = await discoverSitemapUrls(target, { userAgent: 'T/1', dnsLookup: publicDns });
    expect(result.urls).toEqual(['https://venue.example.com/events/a']);
  });

  test('no sitemap is a normal condition with a reason, not an error', async () => {
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
    const result = await discoverSitemapUrls(target, { userAgent: 'T/1', dnsLookup: publicDns });
    expect(result.urls).toEqual([]);
    expect(result.reason).toMatch(/no sitemap/i);
  });

  test('caps at maxUrls and reports truncation', async () => {
    const entries = Array.from({ length: 30 }, (_, i) => `<url><loc>https://venue.example.com/p/${i}</loc></url>`).join('');
    globalThis.fetch = (async () => xml(`<urlset>${entries}</urlset>`)) as typeof fetch;

    const result = await discoverSitemapUrls(target, { userAgent: 'T/1', dnsLookup: publicDns, maxUrls: 10 });
    expect(result.urls).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  test('deduplicates repeated entries', async () => {
    globalThis.fetch = (async () =>
      xml(`<urlset>
        <url><loc>https://venue.example.com/events</loc></url>
        <url><loc>https://venue.example.com/events</loc></url>
      </urlset>`)) as typeof fetch;

    const result = await discoverSitemapUrls(target, { userAgent: 'T/1', dnsLookup: publicDns });
    expect(result.urls).toHaveLength(1);
  });

  test('decodes XML entities in locs', async () => {
    globalThis.fetch = (async () =>
      xml('<urlset><url><loc>https://venue.example.com/events?cat=music&amp;month=7</loc></url></urlset>')) as typeof fetch;

    const result = await discoverSitemapUrls(target, { userAgent: 'T/1', dnsLookup: publicDns });
    expect(result.urls[0]).toBe('https://venue.example.com/events?cat=music&month=7');
  });
});
