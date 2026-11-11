import { describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { crawlSite } from '@/crawl-site';
import { createMemoryCrawlStore } from '@/crawl-store';
import type { CrawlTarget } from '@/core/types';
import { publicDns } from '../helpers';

// SITEMAP-LASTMOD-STORE-1: the store keeps each URL's sitemap date, so a recrawl skips entries the sitemap says have not moved.

const target: CrawlTarget = { baseUrl: 'https://dates.example.com', robotsPolicy: 'allow', active: true };
const crawler = () => createCrawler({ userAgent: 'T/1 (+https://t.example/bot)', dnsLookup: publicDns });
const doc = (text: string) =>
  `<html><head><title>T</title></head><body><main><p>${text} fills this page with enough words about the weekly programme and opening hours.</p></main></body></html>`;

function web(dates: Record<string, string>, state: { broken?: string; edition?: string } = {}) {
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
    if (url.pathname === '/sitemap.xml') {
      const rows = Object.entries(dates).map(([p, d]) => `<url><loc>https://dates.example.com${p}</loc><lastmod>${d}</lastmod></url>`);
      return new Response(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows.join('')}</urlset>`, {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    }
    fetched.push(url.pathname);
    if (url.pathname === state.broken) return new Response('nope', { status: 500 });
    return new Response(doc(`Page ${url.pathname} ${state.edition ?? ''}`), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }) as typeof fetch;
  return fetched;
}

const opts = { useSitemap: true, followLinks: false, storeIntervalMs: 0, nearDuplicateDistance: -1, recrawlMinIntervalMs: 1, maxRetries: 0 };
const dates = { '/a': '2026-01-01', '/b': '2026-01-01', '/c': '2026-01-01' };

describe('sitemap dates kept in the store', () => {
  test('a recrawl fetches only the entries whose date moved', async () => {
    const store = createMemoryCrawlStore();
    const first = web(dates);
    await crawlSite(crawler(), target, { ...opts, store });
    expect(first.sort()).toEqual(['/a', '/b', '/c']);

    await new Promise((r) => setTimeout(r, 5));
    const second = web({ ...dates, '/b': '2026-02-01' });
    await crawlSite(crawler(), target, { ...opts, store });
    expect(second).toEqual(['/b']);
  });

  test('a page that failed is not skipped on the next run', async () => {
    const store = createMemoryCrawlStore();
    web(dates, { broken: '/c' });
    await crawlSite(crawler(), target, { ...opts, store });

    await new Promise((r) => setTimeout(r, 5));
    const second = web(dates);
    await crawlSite(crawler(), target, { ...opts, store });
    expect(second).toEqual(['/c']);
  });
});

describe('a sitemap entry that redirects', () => {
  test('is skipped on the next run when its date has not moved', async () => {
    const store = createMemoryCrawlStore();
    const fetched: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      if (url.pathname === '/sitemap.xml') {
        return new Response(
          '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://dates.example.com/old</loc><lastmod>2026-01-01</lastmod></url></urlset>',
          { status: 200, headers: { 'content-type': 'application/xml' } },
        );
      }
      fetched.push(url.pathname);
      if (url.pathname === '/old') return new Response(null, { status: 301, headers: { location: '/new' } });
      // A real response reports the URL it was served from, which after a redirect is the new one.
      const served = new Response(doc('Moved page'), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      Object.defineProperty(served, 'url', { value: url.toString() });
      return served;
    }) as typeof fetch;
    await crawlSite(crawler(), target, { ...opts, store });
    expect(fetched).toContain('/new');
    fetched.length = 0;
    await new Promise((r) => setTimeout(r, 5));
    await crawlSite(crawler(), target, { ...opts, store });
    expect(fetched).toEqual([]);
  });
});

describe('recrawl wait after a change', () => {
  test('a changed page returns to the minimum wait and an unchanged one keeps doubling', async () => {
    const store = createMemoryCrawlStore();
    const state = { edition: 'one' };
    const urls = { '/a': '2026-01-01' };
    web(urls, state);
    const base = { ...opts, useSitemap: false, seeds: ['https://dates.example.com/a'], store };
    await crawlSite(crawler(), target, base);
    await new Promise((r) => setTimeout(r, 3));
    await crawlSite(crawler(), target, base);
    await new Promise((r) => setTimeout(r, 3));
    await crawlSite(crawler(), target, base);
    const streak = async () => Object.values((await store.load(target.baseUrl))!.schedule)[0]!.unchangedStreak;
    expect(await streak()).toBeGreaterThanOrEqual(1);

    state.edition = 'two';
    await new Promise((r) => setTimeout(r, 3));
    await crawlSite(crawler(), target, base);
    expect(await streak()).toBe(0);
  });
});
