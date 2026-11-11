import { describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import type { CrawlTarget } from '@/core/types';
import { publicDns } from '../helpers';

// CRAWL-PROXY-1: a blocked host retries through the caller's own proxy before Jina or any paid lane.

const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };
const PAGE =
  '<html><head><title>Venue</title></head><body><main><p>Outdoor concert series every Friday at Example Park, doors at six, free admission.</p></main></body></html>';
const JINA_BODY =
  'Title: Recovered\nURL Source: https://venue.example.com/x\n\nMarkdown Content:\nJina served this. ' +
  'Outdoor concert series every Friday at Example Park, doors at six, free admission. '.repeat(4);

function direct(order: string[], status = 403) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('r.jina.ai')) {
      order.push('jina');
      return new Response(JINA_BODY, { status: 200 });
    }
    order.push('direct');
    return new Response('Forbidden', { status });
  }) as typeof fetch;
}

const html = { 'content-type': 'text/html; charset=utf-8' };

describe('the proxy rung', () => {
  test('a 403 retries through the proxy before Jina', async () => {
    const order: string[] = [];
    direct(order);
    const proxyFetch = (async (input: RequestInfo | URL) => {
      order.push(`proxy:${String(input)}`);
      return new Response(PAGE, { status: 200, headers: html });
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example/bot)', dnsLookup: publicDns, proxyFetch });
    const result = await crawler.crawl(target, 'https://venue.example.com/x');

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.rung).toBe('proxy');
    expect(order).toEqual(['direct', 'proxy:https://venue.example.com/x']);
  });

  test('falls through to Jina when the proxy is blocked too', async () => {
    const order: string[] = [];
    direct(order);
    const proxyFetch = (async () => {
      order.push('proxy');
      return new Response('no', { status: 403 });
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example/bot)', dnsLookup: publicDns, proxyFetch });
    const result = await crawler.crawl(target, 'https://venue.example.com/x');

    expect(result.ok).toBe(true);
    expect(order).toEqual(['direct', 'proxy', 'jina']);
  });

  test('a private destination is refused before the proxy is contacted', async () => {
    const order: string[] = [];
    direct(order);
    const proxyFetch = (async () => {
      order.push('proxy');
      return new Response(PAGE, { status: 200, headers: html });
    }) as typeof fetch;
    const privateDns = async () => [{ address: '10.0.0.5', family: 4 }];

    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example/bot)', dnsLookup: privateDns, proxyFetch });
    const result = await crawler.crawl(target, 'https://venue.example.com/x');

    expect(result.ok).toBe(false);
    expect(order).not.toContain('proxy');
  });

  test('a credentialed target never reaches the proxy', async () => {
    const order: string[] = [];
    direct(order);
    const proxyFetch = (async () => {
      order.push('proxy');
      return new Response(PAGE, { status: 200, headers: html });
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example/bot)', dnsLookup: publicDns, proxyFetch });
    await crawler.crawl({ ...target, headers: { authorization: 'Bearer x' } }, 'https://venue.example.com/x');

    expect(order).not.toContain('proxy');
  });

  test('without a proxy the ladder is unchanged', async () => {
    const order: string[] = [];
    direct(order);
    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example/bot)', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://venue.example.com/x');
    expect(result.ok).toBe(true);
    expect(order).toEqual(['direct', 'jina']);
  });

  test('a redirect off the site is refused on the proxy path', async () => {
    const order: string[] = [];
    direct(order);
    const proxyFetch = (async (input: RequestInfo | URL) => {
      order.push(`proxy:${String(input)}`);
      return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.net/' } });
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example/bot)', dnsLookup: publicDns, proxyFetch });
    await crawler.crawl(target, 'https://venue.example.com/x');

    expect(order.filter((o) => o.startsWith('proxy:'))).toEqual(['proxy:https://venue.example.com/x']);
    // The off-site Location is never requested, by the proxy or by anything else.
    expect(order.some((o) => o.includes('elsewhere.example.net'))).toBe(false);
  });
});
