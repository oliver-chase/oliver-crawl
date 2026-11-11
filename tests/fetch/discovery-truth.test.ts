import { describe, expect, test } from 'vitest';
import { fetchViaWayback } from '@/fetch/wayback-fetch';
import { discoverSitemapUrls } from '@/fetch/sitemap-discovery';
import type { CrawlTarget } from '@/core/types';
import { publicDns } from '../helpers';

// Discovery and the archive report what happened: an empty index is "no capture", and a sitemap index with
// more children than are read is reported as cut short.

describe('the archive', () => {
  test('an empty index body means there is no capture', async () => {
    const result = await fetchViaWayback('https://a.example.com/x', {
      fetchImpl: (async () => new Response('', { status: 200 })) as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/no archived capture/i);
  });
});

describe('a sitemap index', () => {
  test('more child sitemaps than are read is reported as truncated', async () => {
    const target: CrawlTarget = { baseUrl: 'https://map.example.com', robotsPolicy: 'allow', active: true };
    const children = Array.from({ length: 8 }, (_, i) => `<sitemap><loc>https://map.example.com/s${i}.xml</loc></sitemap>`).join('');
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const xml = url.pathname === '/sitemap.xml'
        ? `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${children}</sitemapindex>`
        : `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://map.example.com/p${url.pathname.length}</loc></url></urlset>`;
      return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } });
    }) as typeof fetch;
    const found = await discoverSitemapUrls(target, { userAgent: 'T/1 (+https://t.example/bot)', dnsLookup: publicDns });
    expect(found.truncated).toBe(true);
  });
});
