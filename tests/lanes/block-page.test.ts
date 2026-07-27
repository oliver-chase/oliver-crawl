import { afterEach, describe, expect, test } from 'vitest';
import { createCrawler, looksLikeBlockPage } from '@/index';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import { __clearRobotsCacheForTests } from '@/lanes/own/index';
import type { CrawlTarget } from '@/core/types';

// LADDER-QUALITY-1, found live: local render captured Cloudflare's "Why have
// I been blocked?" page and the ladder accepted it — a 300-character security
// notice beat the rung that retrieves the real content, and the crawl
// reported success while delivering the wall.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const target: CrawlTarget = { baseUrl: 'https://site.example.com', robotsPolicy: 'allow', active: true };

const BLOCK_HTML =
  '<html><head><title>Attention Required! | Cloudflare</title></head><body><main>' +
  '<h2>Why have I been blocked?</h2><p>This website is using a security service to protect itself from online attacks.</p>' +
  '</main></body></html>';

const JINA_BODY =
  'Title: Real page\nURL Source: https://site.example.com/x\n\nMarkdown Content:\n' +
  'The full catalogue is available for browsing, with weekly additions and supplier details. '.repeat(4);

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
  __clearRobotsCacheForTests();
});

describe('looksLikeBlockPage', () => {
  test.each([
    'Why have I been blocked? This website is using a security service.',
    'Just a moment... Enable JavaScript and cookies to continue',
    'Verifying you are human. This may take a few seconds.',
    'Request unsuccessful. Incapsula incident ID: 443000210',
  ])('recognises %j', (text) => {
    expect(looksLikeBlockPage(text)).toBe(true);
  });

  test('a real page is not a block page', () => {
    expect(looksLikeBlockPage('Our full catalogue is open for browsing with weekly additions.')).toBe(false);
  });

  test('a long article QUOTING a block page is not a block page', () => {
    const article =
      'How anti-bot systems work: when you see "Why have I been blocked?" it means the site uses a WAF. '.repeat(40);
    expect(looksLikeBlockPage(article)).toBe(false);
  });
});

describe('a rendered block page does not end the ladder', () => {
  test('a 200 block page from the direct fetch falls through to a rung with real content', async () => {
    const rungs: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('r.jina.ai')) {
        rungs.push('jina');
        return new Response(JINA_BODY, { status: 200 });
      }
      rungs.push('fetch');
      // The wall served as a SUCCESS status — the case a status check misses.
      return new Response(BLOCK_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://site.example.com/x');

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.rung).toBe('jina');
    expect(result.pages[0]!.text).toContain('catalogue');
    expect(result.pages[0]!.text).not.toContain('blocked');
  });

  test('a remote-rendered block page is a rung failure, not content', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('render.example.com')) {
        return new Response(JSON.stringify({ html: BLOCK_HTML }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('r.jina.ai')) return new Response(JINA_BODY, { status: 200 });
      return new Response('Forbidden', { status: 403 });
    }) as typeof fetch;

    const crawler = createCrawler({
      userAgent: 'T/1 (+https://t.example.com)',
      dnsLookup: publicDns,
      browserRender: { url: 'https://render.example.com' },
    });
    const result = await crawler.crawl(target, 'https://site.example.com/x');

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    // The render "succeeded" but produced the wall — Jina's real content wins.
    expect(result.pages[0]!.rung).toBe('jina');
  });
});
