import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { crawlSite } from '@/crawl-site';
import { discoverSitemapUrls } from '@/fetch/sitemap-discovery';
import { probeCheapChangeSignal, cheapSignalsMatch } from '@/fetch/cheap-change-probe';
import type { CrawlTarget } from '@/core/types';
import { publicDns } from '../helpers';

// A result says what happened: a 304 needs validators, a failed probe read is unknown, failures carry their class,
// permanent failures are not retried, a resolver outage can clear, store errors are reported and a capped sitemap says so.

const UA = 'T/1 (+https://t.example/bot)';
const target = (host: string): CrawlTarget => ({ baseUrl: `https://${host}`, robotsPolicy: 'allow', active: true });
const crawler = (extra = {}) => createCrawler({ userAgent: UA, dnsLookup: publicDns, rungMemory: false, ...extra });
const notRobots = (input: RequestInfo | URL) => new URL(String(input)).pathname !== '/robots.txt';
const html = '<html><head><title>T</title></head><body><main><p>Weekly concerts at the riverside stage all summer long with free admission.</p></main></body></html>';

describe('a 304', () => {
  test('without validators sent is a failure, with them it is notModified', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => (notRobots(input) ? new Response(null, { status: 304 }) : new Response('', { status: 404 }))) as typeof fetch;
    const bare = await crawler().crawl(target('a.example.com'), 'https://a.example.com/x', { retries: 0 });
    expect(bare.ok).toBe(false);
    const conditional = await crawler().crawl(target('a.example.com'), 'https://a.example.com/y', { retries: 0, etag: '"v1"' });
    expect(conditional.ok && conditional.notModified).toBe(true);
  });
});

describe('the change probe', () => {
  test('two failed body reads do not match', async () => {
    const failing = () => new Response(new ReadableStream({ pull: (c) => c.error(new Error('reset')) }), { status: 200 });
    globalThis.fetch = (async () => failing()) as typeof fetch;
    const t = target('p.example.com');
    const a = await probeCheapChangeSignal(t, 'https://p.example.com/', { dnsLookup: publicDns });
    const b = await probeCheapChangeSignal(t, 'https://p.example.com/', { dnsLookup: publicDns });
    expect(cheapSignalsMatch(a, b)).toBe(false);
  });
});

describe('failures', () => {
  test('a site crawl failure carries its class', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => new Response('gone', { status: 404 })) as typeof fetch;
    const run = await crawlSite(crawler(), target('f.example.com'), { maxRetries: 0 });
    expect(run.failures[0]?.failureClass).toBe('structural');
  });

  test('a structural failure is fetched once however many retries are asked for', async () => {
    let fetches = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (notRobots(input)) fetches++;
      return new Response('gone', { status: 404 });
    }) as typeof fetch;
    await crawler().crawl(target('r.example.com'), 'https://r.example.com/gone', { retries: 3 });
    const withRetries = fetches;
    fetches = 0;
    await crawler().crawl(target('r.example.com'), 'https://r.example.com/gone2', { retries: 0 });
    expect(withRetries).toBe(fetches);
  });

  test('a resolver outage is transient and unreachable', async () => {
    const failing = createCrawler({ userAgent: UA, dnsLookup: async () => { throw new Error('getaddrinfo EAI_AGAIN'); }, rungMemory: false });
    const result = await failing.crawl(target('d.example.com'), 'https://d.example.com/x', { retries: 0 });
    expect(result).toMatchObject({ ok: false, reason: 'unreachable', failureClass: 'transient' });
  });

  test('a private address stays blocked and structural', async () => {
    const inward = createCrawler({ userAgent: UA, dnsLookup: async () => [{ address: '10.0.0.5', family: 4 }], rungMemory: false });
    const result = await inward.crawl(target('i.example.com'), 'https://i.example.com/x', { retries: 0 });
    expect(result).toMatchObject({ ok: false, reason: 'blocked', failureClass: 'structural' });
  });
});

describe('the store', () => {
  test('a save that throws is reported and the crawl still completes', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => (notRobots(input) ? new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('', { status: 404 }))) as typeof fetch;
    const store = { load: () => null, save: () => { throw new Error('disk full'); } };
    const run = await crawlSite(crawler(), target('s.example.com'), { store, storeIntervalMs: 0 });
    expect(run.pages).toHaveLength(1);
    expect(run.storeError).toBe('disk full');
  });

  test('a working store reports no error', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => (notRobots(input) ? new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('', { status: 404 }))) as typeof fetch;
    const run = await crawlSite(crawler(), target('w.example.com'), { store: { load: () => null, save: () => undefined }, storeIntervalMs: 0 });
    expect(run.storeError).toBeUndefined();
  });
});

describe('sitemaps', () => {
  const urlset = (n: number) =>
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from({ length: n }, (_, i) => `<url><loc>https://sm.example.com/page-${i}</loc></url>`).join('')}</urlset>`;

  test('a gzipped sitemap is read', async () => {
    globalThis.fetch = (async () => new Response(gzipSync(urlset(5)), { status: 200, headers: { 'content-type': 'application/gzip' } })) as typeof fetch;
    const found = await discoverSitemapUrls(target('sm.example.com'), { userAgent: UA, dnsLookup: publicDns });
    expect(found.urls).toHaveLength(5);
  });

  test('a sitemap larger than the read cap says it was cut short', async () => {
    const padded = `${urlset(3).replace('</urlset>', '')}<!-- ${'x'.repeat(10_100_000)} --></urlset>`;
    globalThis.fetch = (async () => new Response(padded, { status: 200, headers: { 'content-type': 'application/xml' } })) as typeof fetch;
    const found = await discoverSitemapUrls(target('sm.example.com'), { userAgent: UA, dnsLookup: publicDns });
    expect(found.urls).toHaveLength(3);
    expect(found.truncated).toBe(true);
  });
});

describe('a moved origin', () => {
  test('is not remembered as a winning rung, so the next crawl detects the move again', async () => {
    const JINA = 'Title: New owner\nURL Source: https://moved.example.com/x\n\nMarkdown Content:\n' + 'Outdoor concert series every Friday at Example Park, doors at six, free admission. '.repeat(4);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'r.jina.ai') return new Response(JINA, { status: 200 });
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      return new Response(null, { status: 301, headers: { location: 'http://other-owner.example.org/x' } });
    }) as typeof fetch;
    const c = createCrawler({ userAgent: UA, dnsLookup: publicDns });
    const first = await c.crawl(target('moved.example.com'), 'https://moved.example.com/x', { retries: 0 });
    const second = await c.crawl(target('moved.example.com'), 'https://moved.example.com/y', { retries: 0 });
    for (const result of [first, second]) {
      expect(result.ok && !result.notModified && result.originMoved).toBeTruthy();
    }
  });
});
