import { afterEach, describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import { __clearRobotsCacheForTests } from '@/lanes/own/index';
import type { CrawlTarget } from '@/core/types';

// THIN-PAGE-1: the ladder escalated only on an EMPTY parse, so a JavaScript
// page shipping a nav and footer but no content read as a success. Measured
// live: 1,232 characters of chrome from a plain fetch, 5,519 once rendered.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const target: CrawlTarget = { baseUrl: 'https://site.example.com', robotsPolicy: 'allow', active: true };

const CHROME_ONLY = '<html><head><title>T</title></head><body><main><p>Home About Contact Privacy Terms</p></main></body></html>';
const FULL = `<html><head><title>T</title></head><body><main><p>${'The full catalogue with supplier details and weekly additions. '.repeat(8)}</p></main></body></html>`;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
  __clearRobotsCacheForTests();
});

function stub(fetched: string, rendered: string | null) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('render.example.com')) {
      return rendered
        ? new Response(JSON.stringify({ html: rendered }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('no render', { status: 500 });
    }
    if (url.includes('r.jina.ai')) return new Response('', { status: 500 });
    return new Response(fetched, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }) as typeof fetch;
}

const crawler = (extra = {}) =>
  createCrawler({
    userAgent: 'T/1 (+https://t.example.com)',
    dnsLookup: publicDns,
    browserRender: { url: 'https://render.example.com' },
    ...extra,
  });

describe('a thin page escalates when a threshold is set', () => {
  test('a chrome-only page is re-fetched by the render rung', async () => {
    stub(CHROME_ONLY, FULL);
    const r = await crawler({ renderWhenTextBelow: 400 }).crawl(target, 'https://site.example.com/x');

    expect(r.ok).toBe(true);
    if (!r.ok || r.notModified) throw new Error('expected pages');
    expect(r.pages[0]!.rung).toBe('browser-render');
    expect(r.pages[0]!.text).toContain('full catalogue');
  });

  test('a page already above the threshold is not re-fetched', async () => {
    let renderCalled = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('render.example.com')) {
        renderCalled = true;
        return new Response(JSON.stringify({ html: FULL }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(FULL, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;

    await crawler({ renderWhenTextBelow: 400 }).crawl(target, 'https://site.example.com/x');
    expect(renderCalled).toBe(false);
  });
});

describe('the escalation never loses the page it already had', () => {
  test('a failed render keeps the thin page', async () => {
    // Rendering a page that was already complete costs time, never data.
    stub(CHROME_ONLY, null);
    const r = await crawler({ renderWhenTextBelow: 400 }).crawl(target, 'https://site.example.com/x');

    expect(r.ok).toBe(true);
    if (!r.ok || r.notModified) throw new Error('expected the thin page back');
    expect(r.pages[0]!.rung).toBe('fetch');
  });

  test('a render returning LESS than the fetch is discarded', async () => {
    stub(FULL.replace('</main>', '</main>'), CHROME_ONLY);
    const r = await crawler({ renderWhenTextBelow: 100_000 }).crawl(target, 'https://site.example.com/x');

    if (!r.ok || r.notModified) throw new Error('expected pages');
    // The longer of the two wins, whichever rung produced it.
    expect(r.pages[0]!.text).toContain('full catalogue');
  });
});

describe('it is off unless asked for', () => {
  test('no threshold means no escalation', async () => {
    let renderCalled = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('render.example.com')) {
        renderCalled = true;
        return new Response(JSON.stringify({ html: FULL }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(CHROME_ONLY, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;

    const r = await crawler().crawl(target, 'https://site.example.com/x');
    expect(renderCalled).toBe(false);
    if (!r.ok || r.notModified) throw new Error('expected pages');
    expect(r.pages[0]!.rung).toBe('fetch');
  });
});
