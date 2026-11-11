import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCrawler } from '@/index';
import { crawlSite, crawlSites } from '@/crawl-site';
import type { CrawlStore, CrawlState } from '@/crawl-store';
import type { CrawlTarget, UsageEvent } from '@/core/types';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { publicDns } from '../helpers';

// Behavior the first QA pass found unproven: eight in flight, Crawl-delay under concurrency, per-host reports
// across hosts, a store that holds only JSON, and no fetch once a host turns private.

const ua = 'T/1 (+https://t.example/bot)';
const site = (host: string): CrawlTarget => ({ baseUrl: `https://${host}`, robotsPolicy: 'allow', active: true });
const doc = (links: string[] = []) =>
  `<html><head><title>T</title></head><body><main><p>Weekly concerts at the riverside stage all summer long.</p>${links
    .map((l) => `<a href="${l}">x</a>`)
    .join('')}</main></body></html>`;
const html = { 'content-type': 'text/html; charset=utf-8' };

afterEach(() => {
  vi.useRealTimers();
  __clearDnsCacheForTests();
});

describe('eight requests in flight', () => {
  test('one origin that allows eight runs eight together', async () => {
    let live = 0;
    let peak = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 40));
      live--;
      const links = url.pathname === '/' ? Array.from({ length: 12 }, (_, i) => `/p${i}`) : [];
      return new Response(doc(links), { status: 200, headers: html });
    }) as typeof fetch;
    const run = await crawlSite(createCrawler({ userAgent: ua, dnsLookup: publicDns }), site('wide.example.com'), {
      followLinks: true,
      maxDepth: 1,
      maxPages: 20,
      concurrency: 8,
      perHostConcurrency: 8,
      nearDuplicateDistance: -1,
    });
    expect(run.pages.length).toBe(13);
    expect(peak).toBe(8);
  });
});

describe('Crawl-delay under concurrency', () => {
  test('requests to a host start at least the published delay apart', async () => {
    const starts: number[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\nCrawl-delay: 0.08\n', { status: 200 });
      starts.push(Date.now());
      const links = url.pathname === '/' ? ['/a', '/b', '/c'] : [];
      return new Response(doc(links), { status: 200, headers: html });
    }) as typeof fetch;
    const run = await crawlSite(createCrawler({ userAgent: ua, dnsLookup: publicDns, autoRobots: true }), { ...site('slow.example.com'), robotsPolicy: 'unknown' }, {
      followLinks: true,
      maxDepth: 1,
      maxPages: 10,
      concurrency: 4,
      perHostConcurrency: 4,
      nearDuplicateDistance: -1,
    });
    expect(run.pages.length).toBe(4);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
    expect(gaps.length).toBe(3);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(70);
  });
});

describe('a run across two hosts', () => {
  test('each host reports its own pages and block rate, and usage events carry a duration', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      if (url.hostname === 'walled.example.com' && url.pathname !== '/') return new Response('no', { status: 403 });
      const links = url.pathname === '/' ? ['/a', '/b'] : [];
      return new Response(doc(links), { status: 200, headers: html });
    }) as typeof fetch;
    const events: UsageEvent[] = [];
    const crawler = createCrawler({ userAgent: ua, dnsLookup: publicDns, onUsage: (e) => events.push(e) });
    const out = await crawlSites(crawler, [site('open.example.com'), site('walled.example.com')], {
      followLinks: true,
      maxDepth: 1,
      maxPages: 10,
      maxRetries: 0,
      siteConcurrency: 2,
      nearDuplicateDistance: -1,
    });
    const open = out[0]!.result.hosts['open.example.com']!;
    const walled = out[1]!.result.hosts['walled.example.com']!;
    expect(open.pages).toBe(3);
    expect(open.blockRate).toBe(0);
    expect(walled.pages).toBe(1);
    expect(walled.blockRate).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(['open.example.com', 'walled.example.com']).toContain(e.host);
      expect(Number.isFinite(e.latencyMs)).toBe(true);
      expect(e.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('a store that holds only JSON', () => {
  test('a new crawler continues from state that went through a string and back', async () => {
    const disk = new Map<string, string>();
    const store: CrawlStore = {
      load: (key) => (disk.has(key) ? (JSON.parse(disk.get(key)!) as CrawlState) : null),
      save: (key, state) => void disk.set(key, JSON.stringify(state)),
    };
    const fetched: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      fetched.push(url.pathname);
      const links = url.pathname === '/' ? ['/a', '/b', '/c', '/d'] : [];
      return new Response(doc(links).replace('concerts', `concerts ${url.pathname}`), { status: 200, headers: html });
    }) as typeof fetch;
    const base = { followLinks: true, maxDepth: 1, storeIntervalMs: 0, nearDuplicateDistance: -1, store, recrawlMinIntervalMs: 3_600_000 };
    const first = await crawlSite(createCrawler({ userAgent: ua, dnsLookup: publicDns }), site('resume.example.com'), { ...base, maxPages: 3 });
    expect(first.truncated).toBe(true);
    const done = [...fetched];

    const second = await crawlSite(createCrawler({ userAgent: ua, dnsLookup: publicDns }), site('resume.example.com'), { ...base, maxPages: 10 });
    expect(fetched.slice(done.length).filter((p) => done.includes(p))).toEqual([]);
    expect(first.pages.length + second.pages.length).toBe(5);
  });
});

describe('a host that turns private after its verdict expires', () => {
  test('the request is refused and no fetch is made', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let address = '93.184.216.34';
    const lookup = async () => [{ address, family: 4 }];
    const fetched: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      fetched.push(url.pathname);
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      return new Response(doc(), { status: 200, headers: html });
    }) as typeof fetch;
    const crawler = createCrawler({ userAgent: ua, dnsLookup: lookup });
    const target = site('rebind.example.com');
    const ok = await crawler.crawl(target, 'https://rebind.example.com/first');
    expect(ok.ok).toBe(true);

    vi.setSystemTime(Date.now() + 61_000);
    address = '10.0.0.5';
    fetched.length = 0;
    const refused = await crawler.crawl(target, 'https://rebind.example.com/second');
    expect(refused.ok).toBe(false);
    expect(fetched).toEqual([]);
  });
});
