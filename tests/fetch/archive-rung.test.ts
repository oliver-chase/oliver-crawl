import { afterEach, describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import { __clearRobotsCacheForTests } from '@/lanes/own/index';
import type { CrawlTarget } from '@/core/types';

// WAYBACK-RUNG-1: the gate matters more than the feature. An archive fallback
// is trivially a way to read pages a site refused, and building that would
// make every other guard in this package decorative.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const ARCHIVED = '<html><head><title>Archived</title></head><body><main><p>The catalogue as captured last month.</p></main></body></html>';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
  __clearRobotsCacheForTests();
});

/** Live host is dead; the archive has a capture. */
function deadHostWithArchive() {
  const hit: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/cdx/search/cdx')) {
      hit.push('cdx');
      return new Response(JSON.stringify([['timestamp', 'original'], ['20260601120000', 'https://site.example.com/x']]), { status: 200 });
    }
    if (url.includes('web.archive.org/web/')) {
      hit.push('snapshot');
      return new Response(ARCHIVED, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url.includes('r.jina.ai')) return new Response('', { status: 500 });
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  return hit;
}

const crawler = (extra = {}) =>
  createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns, useArchiveFallback: true, ...extra });

// What these verify: that a disallowed, unresolved or credentialed target
// NEVER reaches the archive. They do not isolate which layer stops it — an
// ablation showed the policy gate stops disallow/unknown before the rung's own
// check is reached. The behaviour asserted is the one that matters; the
// redundancy is documented at the check itself.
describe('a target that is not explicitly permitted never reaches the archive', () => {
  test('robotsPolicy allow: the archived page is returned', async () => {
    deadHostWithArchive();
    const target: CrawlTarget = { baseUrl: 'https://site.example.com', robotsPolicy: 'allow', active: true };
    const r = await crawler().crawl(target, 'https://site.example.com/x');

    expect(r.ok).toBe(true);
    if (!r.ok || r.notModified) throw new Error('expected pages');
    expect(r.pages[0]!.rung).toBe('archive');
    expect(r.pages[0]!.text).toContain('catalogue');
  });

  test('robotsPolicy disallow: the site said no, and no copy is read', async () => {
    const hit = deadHostWithArchive();
    const target: CrawlTarget = { baseUrl: 'https://site.example.com', robotsPolicy: 'disallow', active: true };
    const r = await crawler().crawl(target, 'https://site.example.com/x');

    expect(r.ok).toBe(false);
    expect(hit).toEqual([]); // the archive was not even asked
  });

  test('robotsPolicy unknown: an archive does not launder an unresolved posture', async () => {
    const hit = deadHostWithArchive();
    const target: CrawlTarget = { baseUrl: 'https://site.example.com', active: true };
    const r = await crawler().crawl(target, 'https://site.example.com/x');

    expect(r.ok).toBe(false);
    expect(hit).toEqual([]);
  });

  test('off by default', async () => {
    const hit = deadHostWithArchive();
    const target: CrawlTarget = { baseUrl: 'https://site.example.com', robotsPolicy: 'allow', active: true };
    const plain = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns });
    const r = await plain.crawl(target, 'https://site.example.com/x');

    expect(r.ok).toBe(false);
    expect(hit).toEqual([]);
  });

  test('a credentialed target is never looked up in a public archive', async () => {
    const hit = deadHostWithArchive();
    const target: CrawlTarget = {
      baseUrl: 'https://site.example.com',
      robotsPolicy: 'allow',
      active: true,
      headers: { authorization: 'Bearer secret' },
    };
    const r = await crawler().crawl(target, 'https://site.example.com/members/x');

    expect(r.ok).toBe(false);
    expect(hit).toEqual([]);
  });
});

describe('the archive rung is last, and honest about what it returns', () => {
  test('a live rung that works is preferred over the archive', async () => {
    // An archived copy is older by definition; preferring it would serve stale
    // data silently.
    const hit: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('web.archive.org')) {
        hit.push('archive');
        return new Response(ARCHIVED, { status: 200 });
      }
      return new Response(
        '<html><head><title>Live</title></head><body><main><p>The live catalogue, updated today.</p></main></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }) as typeof fetch;

    const target: CrawlTarget = { baseUrl: 'https://site.example.com', robotsPolicy: 'allow', active: true };
    const r = await crawler().crawl(target, 'https://site.example.com/x');

    if (!r.ok || r.notModified) throw new Error('expected pages');
    expect(r.pages[0]!.rung).toBe('fetch');
    expect(hit).toEqual([]);
  });

  test('an archived 404 is not served as content', async () => {
    // The archive faithfully stores error pages too.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/cdx/search/cdx')) {
        // statuscode:200 filter means a 404-only history returns just a header
        return new Response(JSON.stringify([['timestamp', 'original']]), { status: 200 });
      }
      if (url.includes('r.jina.ai')) return new Response('', { status: 500 });
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    const target: CrawlTarget = { baseUrl: 'https://site.example.com', robotsPolicy: 'allow', active: true };
    const r = await crawler().crawl(target, 'https://site.example.com/x');
    expect(r.ok).toBe(false);
  });

  test('a capture older than archiveMaxAgeDays is refused', async () => {
    deadHostWithArchive(); // capture stamped 2026-06-01
    const target: CrawlTarget = { baseUrl: 'https://site.example.com', robotsPolicy: 'allow', active: true };
    const r = await crawler({ archiveMaxAgeDays: 1 }).crawl(target, 'https://site.example.com/x');
    expect(r.ok).toBe(false);
  });
});
