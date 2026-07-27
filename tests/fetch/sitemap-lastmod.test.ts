import { afterEach, describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { crawlSite } from '@/crawl-site';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import type { CrawlTarget } from '@/core/types';

// BETTER-LASTMOD-1: a sitemap answers "which of these pages changed" in ONE
// request. Conditional GET answers the same question in one request PER PAGE.
// We were already fetching the sitemap and throwing the field away.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };

const SITEMAP = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  '  <url><loc>https://venue.example.com/a</loc><lastmod>2026-07-01</lastmod></url>',
  '  <url><loc>https://venue.example.com/b</loc><lastmod>2026-07-02</lastmod></url>',
  '  <url><loc>https://venue.example.com/c</loc></url>',
  '</urlset>',
].join('\n');

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
});

function stub() {
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/sitemap.xml')) {
      return new Response(SITEMAP, { status: 200, headers: { 'content-type': 'application/xml' } });
    }
    fetched.push(url);
    return new Response(
      '<html><head><title>T</title></head><body><main><p>Concerts every Friday at the riverside stage.</p></main></body></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }) as typeof fetch;
  return fetched;
}

const crawler = () => createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });

describe('lastmod is captured and handed back', () => {
  test('a first run reports every published lastmod', async () => {
    stub();
    const run = await crawlSite(crawler(), target, { useSitemap: true, maxPages: 10 });

    expect(run.lastmod['https://venue.example.com/a']).toBe('2026-07-01');
    expect(run.lastmod['https://venue.example.com/b']).toBe('2026-07-02');
    // No <lastmod> published — absent, not invented.
    expect(run.lastmod['https://venue.example.com/c']).toBeUndefined();
    expect(run.skippedByLastmod).toEqual([]);
  });
});

describe('unchanged pages are never fetched at all', () => {
  test('an unmoved lastmod skips the fetch', async () => {
    const fetched = stub();
    const run = await crawlSite(crawler(), target, {
      useSitemap: true,
      maxPages: 10,
      priorLastmod: {
        'https://venue.example.com/a': '2026-07-01',
        'https://venue.example.com/b': '2026-07-02',
      },
    });

    // The saving is the FETCH itself — not a cheaper fetch, no fetch.
    expect(fetched).toEqual(['https://venue.example.com/c']);
    expect(run.skippedByLastmod.sort()).toEqual([
      'https://venue.example.com/a',
      'https://venue.example.com/b',
    ]);
    expect(run.pages).toHaveLength(1);
  });

  test('a moved lastmod is crawled again', async () => {
    const fetched = stub();
    const run = await crawlSite(crawler(), target, {
      useSitemap: true,
      maxPages: 10,
      priorLastmod: {
        'https://venue.example.com/a': '2026-06-01', // stale — page moved
        'https://venue.example.com/b': '2026-07-02', // unchanged
      },
    });

    expect(fetched).toContain('https://venue.example.com/a');
    expect(fetched).not.toContain('https://venue.example.com/b');
    expect(run.skippedByLastmod).toEqual(['https://venue.example.com/b']);
  });

  test('a page with no published lastmod is always crawled', async () => {
    // Absent lastmod can never match, so it can never wrongly skip.
    const fetched = stub();
    await crawlSite(crawler(), target, {
      useSitemap: true,
      maxPages: 10,
      priorLastmod: { 'https://venue.example.com/c': '2026-07-01' },
    });
    expect(fetched).toContain('https://venue.example.com/c');
  });

  test('omitting priorLastmod crawls everything, as before', async () => {
    const fetched = stub();
    const run = await crawlSite(crawler(), target, { useSitemap: true, maxPages: 10 });
    expect(fetched).toHaveLength(3);
    expect(run.skippedByLastmod).toEqual([]);
  });
});
