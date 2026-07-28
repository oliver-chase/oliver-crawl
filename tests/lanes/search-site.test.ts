import { afterEach, describe, expect, test } from 'vitest';
import { createCrawler, searchSite } from '@/index';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import { __clearRobotsCacheForTests } from '@/lanes/own/index';
import type { CrawlTarget } from '@/core/types';

// SEARCH-ONSITE-1: use the site's own search. Free, uncontroversial (it is a
// published feature), and it reaches pages neither links nor a sitemap do.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const target: CrawlTarget = { baseUrl: 'https://site.example.com', robotsPolicy: 'allow', active: true };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
  __clearRobotsCacheForTests();
});

/** A results page carries the site's whole nav, exactly like any other page. */
const RESULTS = `<html><head><title>Search</title></head><body>
  <nav><a href="/">Home</a><a href="/about">About</a><a href="/contact">Contact</a></nav>
  <main>
    <p>3 results for your search.</p>
    <a href="/education/summer-camp/">Summer Camp Programme Details</a>
    <a href="/wp-content/uploads/2025/10/photo.png">Summer Camp Photograph</a>
    <a href="/education/day-camp/">Day Camp Registration Information</a>
  </main>
  <footer><a href="/privacy">Privacy</a></footer>
</body></html>`;

function serve(handler: (url: string) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL) => handler(String(input))) as typeof fetch;
}

const crawler = () => createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns });

describe('results come from the content region, not the whole page', () => {
  test('returns real results and not the navigation', async () => {
    // The bug this guards: using page.links returned "Membership" and "Plan
    // your visit" as hits — worse than nothing, since a consumer would crawl
    // them believing they matched.
    serve((url) => (url.includes('?s=') ? new Response(RESULTS, { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('', { status: 404 })));

    const found = await searchSite(crawler(), target, 'summer camp');

    expect(found.ok).toBe(true);
    expect(found.urls).toContain('https://site.example.com/education/summer-camp/');
    expect(found.urls).toContain('https://site.example.com/education/day-camp/');
    expect(found.urls.some((u) => u.includes('/about'))).toBe(false);
    expect(found.urls.some((u) => u.includes('/privacy'))).toBe(false);
  });

  test('asset links are not results', async () => {
    // A live run returned /wp-content/uploads/*.png as hits; a consumer would
    // then "crawl" a screenshot.
    serve((url) => (url.includes('?s=') ? new Response(RESULTS, { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('', { status: 404 })));

    const found = await searchSite(crawler(), target, 'summer camp');
    expect(found.urls.some((u) => u.includes('/wp-content/'))).toBe(false);
    expect(found.urls.some((u) => u.endsWith('.png'))).toBe(false);
  });

  test('reports which pattern worked, so it can be reused', async () => {
    serve((url) => (url.includes('?s=') ? new Response(RESULTS, { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('', { status: 404 })));
    const found = await searchSite(crawler(), target, 'summer camp');
    expect(found.pattern).toBe('wordpress');
  });

  test('knownPattern skips probing', async () => {
    const tried: string[] = [];
    serve((url) => {
      tried.push(url);
      return url.includes('/search?q=')
        ? new Response(RESULTS, { status: 200, headers: { 'content-type': 'text/html' } })
        : new Response('', { status: 404 });
    });

    await searchSite(crawler(), target, 'summer camp', { knownPattern: 'generic' });
    // Exactly one request: the pattern already known to work.
    expect(tried.filter((u) => !u.endsWith('/robots.txt'))).toHaveLength(1);
  });
});

describe('a site with no usable search answers rather than throws', () => {
  test('every pattern 404ing yields ok:false with a reason', async () => {
    serve(() => new Response('', { status: 404 }));
    const found = await searchSite(crawler(), target, 'anything');

    expect(found.ok).toBe(false);
    expect(found.urls).toEqual([]);
    expect(found.detail).toBeTruthy();
  });

  test('an empty query is refused without a request', async () => {
    let called = false;
    serve(() => {
      called = true;
      return new Response('', { status: 200 });
    });
    const found = await searchSite(crawler(), target, '   ');
    expect(found.ok).toBe(false);
    expect(called).toBe(false);
  });
});
