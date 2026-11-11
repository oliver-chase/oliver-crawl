import { describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { crawlSite, crawlSites } from '@/crawl-site';
import type { CrawlProgress } from '@/crawl-site';
import type { CrawlTarget } from '@/core/types';
import { publicDns } from '../helpers';

// CRAWL-PARALLEL-1: crawlSite is sequential unless asked, and `perHostConcurrency` keeps any one origin to its limit.

const page = (links: string[]) =>
  `<html><head><title>T</title></head><body><main><p>Weekly concerts at the riverside stage all summer long.</p>${links
    .map((l) => `<a href="${l}">x</a>`)
    .join('')}</main></body></html>`;

/** A fake web that records the peak number of requests in flight, overall and per host. */
function web(latencyMs: number) {
  const state = { peak: 0, peakByHost: new Map<string, number>(), live: 0, liveByHost: new Map<string, number>() };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
    state.live++;
    state.peak = Math.max(state.peak, state.live);
    const host = url.hostname;
    const hostLive = (state.liveByHost.get(host) ?? 0) + 1;
    state.liveByHost.set(host, hostLive);
    state.peakByHost.set(host, Math.max(state.peakByHost.get(host) ?? 0, hostLive));
    await new Promise((r) => setTimeout(r, latencyMs));
    state.live--;
    state.liveByHost.set(host, (state.liveByHost.get(host) ?? 1) - 1);
    const body = url.pathname === '/' ? page(['/a', '/b', '/c', '/d']) : page([]);
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }) as typeof fetch;
  return state;
}

const crawler = () => createCrawler({ userAgent: 'T/1 (+https://t.example/bot)', dnsLookup: publicDns });
const site = (host: string): CrawlTarget => ({ baseUrl: `https://${host}`, robotsPolicy: 'allow', active: true });

describe('crawlSite concurrency', () => {
  test('defaults to one request at a time', async () => {
    const state = web(10);
    const run = await crawlSite(crawler(), site('one.example.com'), { followLinks: true, maxDepth: 1, maxPages: 10 });
    expect(run.pages).toHaveLength(5);
    expect(state.peak).toBe(1);
  });

  test('perHostConcurrency lets one origin run in parallel, up to the limit', async () => {
    const state = web(30);
    const run = await crawlSite(crawler(), site('one.example.com'), {
      followLinks: true,
      maxDepth: 1,
      maxPages: 10,
      concurrency: 8,
      perHostConcurrency: 3,
    });
    expect(run.pages).toHaveLength(5);
    expect(state.peakByHost.get('one.example.com')).toBe(3);
  });

  test('concurrency does not change what is collected', async () => {
    web(5);
    const serial = await crawlSite(crawler(), site('one.example.com'), { followLinks: true, maxDepth: 1, maxPages: 10 });
    web(5);
    const parallel = await crawlSite(crawler(), site('one.example.com'), {
      followLinks: true,
      maxDepth: 1,
      maxPages: 10,
      concurrency: 4,
      perHostConcurrency: 4,
    });
    expect(parallel.pages.map((p) => p.url).sort()).toEqual(serial.pages.map((p) => p.url).sort());
  });

  test('maxPages holds under concurrency', async () => {
    web(5);
    const run = await crawlSite(crawler(), site('one.example.com'), {
      followLinks: true,
      maxDepth: 1,
      maxPages: 3,
      concurrency: 4,
      perHostConcurrency: 4,
    });
    expect(run.pages.length + run.notModified.length).toBeLessThanOrEqual(3);
    expect(run.truncated).toBe(true);
  });

  test('a snapshot taken mid-flight keeps the pages still in flight in the queue', async () => {
    web(20);
    const snapshots: CrawlProgress[] = [];
    await crawlSite(crawler(), site('one.example.com'), {
      followLinks: true,
      maxDepth: 1,
      maxPages: 10,
      concurrency: 4,
      perHostConcurrency: 4,
      onProgress: (s) => snapshots.push(s),
    });
    for (const snap of snapshots) {
      const visited = new Set(snap.visited);
      for (const queued of snap.queue) expect(visited.has(queued)).toBe(false);
    }
  });
});

describe('crawlSites', () => {
  test('runs different origins together and each origin stays at one request', async () => {
    const state = web(40);
    const targets = ['a.example.com', 'b.example.com', 'c.example.com'].map(site);
    const out = await crawlSites(crawler(), targets, { followLinks: true, maxDepth: 1, maxPages: 10, siteConcurrency: 3 });
    expect(out.map((o) => o.target.baseUrl)).toEqual(targets.map((t) => t.baseUrl));
    expect(out.every((o) => o.result.pages.length === 5)).toBe(true);
    expect(state.peak).toBeGreaterThan(1);
    for (const peak of state.peakByHost.values()) expect(peak).toBe(1);
  });

  test('two targets on one origin share its limit', async () => {
    const state = web(30);
    const one = site('shared.example.com');
    await crawlSites(crawler(), [one, { ...one }], { followLinks: true, maxDepth: 1, maxPages: 10, siteConcurrency: 2 });
    expect(state.peakByHost.get('shared.example.com')).toBe(1);
  });
});
