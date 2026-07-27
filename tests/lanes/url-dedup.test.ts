import { afterEach, describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { crawlSite } from '@/crawl-site';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import type { CrawlTarget } from '@/core/types';

// URL-DEDUP-1: one page reachable under several spellings must be crawled
// ONCE. A site that links its calendar as /events, /events/, /events#lineup
// and /events?utm_source=fb is not four pages — but a dedup key built from a
// raw URL string sees four, and spends a quarter of maxPages proving it.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
});

function page(body: string) {
  return new Response(`<html><head><title>T</title></head><body><main>${body}</main></body></html>`, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

describe('one page under many spellings is crawled once', () => {
  test('trailing slash, fragment and tracking params collapse', async () => {
    const fetched: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      if (new URL(url).pathname === '/') {
        return page(
          `<p>Welcome to the riverside venue, home of the summer concert series.</p>
           <a href="/events">Events</a>
           <a href="/events/">Our events</a>
           <a href="/events#lineup">Lineup</a>
           <a href="/events?utm_source=facebook">Events on Facebook</a>`,
        );
      }
      return page('<p>The summer concert series runs every Friday evening at the riverside stage.</p>');
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });
    const run = await crawlSite(crawler, target, {
      seeds: ['https://venue.example.com/'],
      followLinks: true,
      maxDepth: 1,
      maxPages: 10,
    });

    expect(fetched.filter((u) => u.includes('/events'))).toHaveLength(1);
    expect(run.pages).toHaveLength(2); // homepage + the one events page
  });

  test('genuinely different query params stay separate pages', async () => {
    // The failure in the other direction: over-normalising merges two real
    // pages and silently loses one. A crawler must never do that.
    const fetched: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      if (new URL(url).pathname === '/') {
        return page(
          `<p>Browse the calendar by month to see the full summer schedule.</p>
           <a href="/cal?month=7">July</a>
           <a href="/cal?month=8">August</a>
           <a href="/cal?ref=nav&amp;month=9">September</a>`,
        );
      }
      return page('<p>Concerts this month at the riverside stage, every Friday at six.</p>');
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });
    const run = await crawlSite(crawler, target, {
      seeds: ['https://venue.example.com/'],
      followLinks: true,
      maxDepth: 1,
      maxPages: 10,
    });

    expect(fetched.filter((u) => u.includes('/cal'))).toHaveLength(3);
    expect(run.pages).toHaveLength(4);
  });
});
