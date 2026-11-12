import { describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { crawlSite } from '@/crawl-site';
import { readPageCache, writePageCache, __clearPageCacheForTests } from '@/core/page-cache';
import type { CrawlResult, CrawlTarget } from '@/core/types';
import { publicDns } from '../helpers';

// A missing page does not walk the live ladder, followLinks does not ship html, and the page cache has a size budget.

const UA = 'T/1 (+https://t.example/bot)';
const target = (host: string): CrawlTarget => ({ baseUrl: `https://${host}`, robotsPolicy: 'allow', active: true });
const page = (links = '') => `<html><head><title>T</title></head><body><main><p>Weekly concerts at the riverside stage all summer long.</p>${links}</main></body></html>`;

describe('which rungs a failure walks', () => {
  const hostsFor = async (status: number, path: string) => {
    const hosts: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      hosts.push(new URL(String(input)).hostname);
      return new Response('x', { status });
    }) as typeof fetch;
    const crawler = createCrawler({ userAgent: UA, dnsLookup: publicDns, rungMemory: false, browserRender: { url: 'https://render.example.net/render' } });
    await crawler.crawl(target('m.example.com'), `https://m.example.com/${path}`, { retries: 0 });
    return hosts;
  };

  test.each([404, 410])('a %s does not reach Jina or the render service', async (status) => {
    const hosts = await hostsFor(status, 'gone');
    expect(hosts).not.toContain('r.jina.ai');
    expect(hosts).not.toContain('render.example.net');
  });

  test('a 403 still walks the ladder', async () => {
    expect(await hostsFor(403, 'blocked')).toContain('r.jina.ai');
  });
});

describe('html is requested only for pagination', () => {
  const web = () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      return new Response(page(url.pathname === '/' ? '<a href="/a">a</a><a rel="next" href="/page/2">next</a>' : ''), { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
  };
  const spied = () => {
    const real = createCrawler({ userAgent: UA, dnsLookup: publicDns });
    const asked: Array<boolean | undefined> = [];
    return { asked, crawler: { ...real, crawl: (t: CrawlTarget, u: string, o?: Parameters<typeof real.crawl>[2]) => { asked.push(o?.includeHtml); return real.crawl(t, u, o); } } };
  };

  test('followLinks alone does not ask for html and returns pages without it', async () => {
    web();
    const { asked, crawler } = spied();
    const run = await crawlSite(crawler, target('l.example.com'), { followLinks: true, maxDepth: 1, nearDuplicateDistance: -1 });
    expect(run.pages.length).toBeGreaterThan(0);
    expect(asked.every((value) => value === false)).toBe(true);
    expect(run.pages.every((p) => p.html === undefined)).toBe(true);
  });

  test('followPagination asks for html but returns pages without it unless includeHtml is set', async () => {
    web();
    const { asked, crawler } = spied();
    const run = await crawlSite(crawler, target('l2.example.com'), { followPagination: true, maxPages: 1, nearDuplicateDistance: -1 });
    expect(asked[0]).toBe(true);
    expect(run.pages.every((p) => p.html === undefined)).toBe(true);
  });

  test('includeHtml keeps html on the returned pages', async () => {
    web();
    const { crawler } = spied();
    const run = await crawlSite(crawler, target('l3.example.com'), { followPagination: true, includeHtml: true, maxPages: 1, nearDuplicateDistance: -1 });
    expect(run.pages.every((p) => typeof p.html === 'string')).toBe(true);
  });
});

describe('the page cache', () => {
  const big = (chars: number): CrawlResult =>
    ({ ok: true, notModified: false, lane: 'own', pages: [{ url: 'u', text: 'x'.repeat(chars), markdown: '' }] }) as unknown as CrawlResult;

  test('stops holding results once the size budget is spent', () => {
    __clearPageCacheForTests();
    for (let i = 0; i < 12; i++) writePageCache(`https://c.example.com/${i}`, undefined, 60_000, big(10_000_000), 'v');
    const held = Array.from({ length: 12 }, (_, i) => readPageCache(`https://c.example.com/${i}`, undefined, 60_000, 'v')).filter(Boolean);
    expect(held.length).toBeLessThanOrEqual(5);
    expect(held.length).toBeGreaterThan(0);
  });
});
