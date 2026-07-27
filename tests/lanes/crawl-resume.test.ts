import { afterEach, describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { crawlSite } from '@/crawl-site';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import type { CrawlProgress } from '@/crawl-site';
import type { CrawlTarget } from '@/core/types';

// CRAWL-RESUME-1: queue and visited live only in memory, so a 500-page crawl
// killed at page 400 restarts from zero. The package stores nothing — it
// hands out a snapshot and takes one back.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
});

// A small site: home links to a, b, c.
function stub() {
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    const body =
      new URL(url).pathname === '/'
        ? `<p>Welcome to the riverside venue and its summer concert series.</p>
           <a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>`
        : // Every inner page links BACK to home, the way real site nav does.
          // This is what makes the restored `visited` set load-bearing: without
          // it the back-link re-enqueues a page the previous run already did.
          `<p>Concerts every Friday evening at the riverside stage this summer.</p>
           <a href="/">Home</a>`;
    return new Response(`<html><head><title>T</title></head><body><main>${body}</main></body></html>`, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }) as typeof fetch;
  return fetched;
}

const crawler = () => createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });

describe('progress snapshots are coherent', () => {
  test('a snapshot never re-lists the page it was emitted for', async () => {
    stub();
    const snapshots: CrawlProgress[] = [];
    await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/'],
      followLinks: true,
      maxDepth: 1,
      maxPages: 10,
      onProgress: (s) => snapshots.push(s),
    });

    expect(snapshots.length).toBeGreaterThan(0);
    // Every snapshot must be a clean "done up to here": nothing in the queue
    // may already be visited, or a resume would re-fetch it.
    for (const snap of snapshots) {
      const visited = new Set(snap.visited);
      for (const queued of snap.queue) {
        expect(visited.has(queued)).toBe(false);
      }
    }
  });

  test('the first snapshot already carries the links just discovered', async () => {
    stub();
    const snapshots: CrawlProgress[] = [];
    await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/'],
      followLinks: true,
      maxDepth: 1,
      maxPages: 10,
      onProgress: (s) => snapshots.push(s),
    });

    // Emitted after discovery, so killing the run here loses no links.
    expect(snapshots[0]!.queue.length).toBe(3);
    expect(snapshots[0]!.collected).toBe(1);
  });
});

describe('resuming continues instead of restarting', () => {
  test('a resumed run does not re-fetch pages already done', async () => {
    stub();
    const snapshots: CrawlProgress[] = [];
    await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/'],
      followLinks: true,
      maxDepth: 1,
      maxPages: 2, // stop early, as if killed
      onProgress: (s) => snapshots.push(s),
    });

    const snapshot = snapshots[snapshots.length - 1]!;
    expect(snapshot.visited.length).toBeGreaterThan(0);

    // Second process, fresh everything — only the snapshot carries over.
    const fetchedAfter = stub();
    const resumed = await crawlSite(crawler(), target, {
      followLinks: true,
      maxDepth: 1,
      maxPages: 10,
      resumeFrom: snapshot,
    });

    // The home page was already done in run one and must not be fetched again.
    expect(fetchedAfter).not.toContain('https://venue.example.com/');
    expect(resumed.pages.length).toBeGreaterThan(0);
  });

  test('together, the two runs cover the site exactly once', async () => {
    const firstFetches = stub();
    const snapshots: CrawlProgress[] = [];
    await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/'],
      followLinks: true,
      maxDepth: 1,
      maxPages: 2,
      onProgress: (s) => snapshots.push(s),
    });

    const secondFetches = stub();
    await crawlSite(crawler(), target, {
      followLinks: true,
      maxDepth: 1,
      maxPages: 10,
      resumeFrom: snapshots[snapshots.length - 1]!,
    });

    const all = [...firstFetches, ...secondFetches];
    expect(new Set(all).size).toBe(all.length); // no page fetched twice
    expect(new Set(all).size).toBe(4); // home + a + b + c
  });

  test('a restored depth is not reset to zero', async () => {
    // Without restoring depths, a resumed page would look like a fresh seed
    // and could crawl maxDepth hops FURTHER than the original run allowed.
    stub();
    const resumed = await crawlSite(crawler(), target, {
      followLinks: true,
      maxDepth: 1,
      maxPages: 10,
      resumeFrom: {
        queue: ['https://venue.example.com/a'],
        visited: ['venue.example.com'],
        depths: { 'venue.example.com/a': 1 },
        collected: 1,
      },
    });

    expect(resumed.pages).toHaveLength(1);
    expect(resumed.pages[0]!.url).toContain('/a');
  });
});
