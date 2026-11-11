import { describe, expect, test, vi } from 'vitest';
import { createCrawler } from '@/index';
import { crawlSite } from '@/crawl-site';
import { createMemoryCrawlStore, isDue } from '@/crawl-store';
import type { CrawlStore } from '@/crawl-store';
import type { CrawlTarget } from '@/core/types';
import { publicDns } from '../helpers';

// CRAWL-STORE-1: a crawl's queue, validators and recrawl schedule live behind a store, so another worker can continue it and each URL knows when it is due.

const target: CrawlTarget = { baseUrl: 'https://store.example.com', robotsPolicy: 'allow', active: true };
const crawler = () => createCrawler({ userAgent: 'T/1 (+https://t.example/bot)', dnsLookup: publicDns });
const doc = (body: string, links: string[] = []) =>
  `<html><head><title>T</title></head><body><main><p>${body}</p>${links.map((l) => `<a href="${l}">x</a>`).join('')}</main></body></html>`;

function web(state: { busy: string } = { busy: 'one' }) {
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
    fetched.push(url.pathname);
    const text = (label: string) => `${label} fills this page with enough words about the weekly programme and opening hours.`;
    const body =
      url.pathname === '/'
        ? doc(text('Home'), ['/a', '/b', '/c', '/stable', '/busy'])
        : url.pathname === '/busy'
          ? doc(text(`Busy edition ${state.busy}`))
          : doc(text(`Page ${url.pathname}`));
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }) as typeof fetch;
  return fetched;
}

const opts = { followLinks: true, maxDepth: 1, storeIntervalMs: 0, nearDuplicateDistance: -1 };

describe('another worker continues a crawl', () => {
  test('a truncated run leaves a snapshot a second run picks up', async () => {
    const store = createMemoryCrawlStore();
    const first = web();
    const run1 = await crawlSite(crawler(), target, { ...opts, store, maxPages: 3 });
    expect(run1.truncated).toBe(true);
    const seen = new Set(first.map((p) => p));

    const second = web();
    const run2 = await crawlSite(crawler(), target, { ...opts, store, maxPages: 10, recrawlMinIntervalMs: 10 * 60 * 60 * 1000 });
    const fetchedAgain = second.filter((p) => seen.has(p));
    expect(fetchedAgain).toEqual([]);
    expect(run1.pages.length + run2.pages.length).toBe(6);
  });

  test('a finished run clears its snapshot', async () => {
    const store = createMemoryCrawlStore();
    web();
    await crawlSite(crawler(), target, { ...opts, store, maxPages: 20 });
    expect((await store.load(target.baseUrl))?.progress).toBeNull();
  });
});

describe('recrawl scheduling', () => {
  test('a second run straight after the first re-reads the start page and skips the rest', async () => {
    const store = createMemoryCrawlStore();
    web();
    await crawlSite(crawler(), target, { ...opts, store, maxPages: 20 });
    const fetched = web();
    const run = await crawlSite(crawler(), target, { ...opts, store, maxPages: 20 });
    expect(fetched).toEqual(['/']);
    expect(run.notDue.length).toBe(5);
  });

  test('a page that keeps changing is due sooner than one that never does', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const hour = 60 * 60 * 1000;
    const store = createMemoryCrawlStore();
    const state = { busy: 'one' };
    const base = { ...opts, store, maxPages: 20, recrawlMinIntervalMs: hour };

    web(state);
    await crawlSite(crawler(), target, base);

    vi.setSystemTime(Date.now() + hour + 1000);
    state.busy = 'two';
    web(state);
    await crawlSite(crawler(), target, base);

    vi.setSystemTime(Date.now() + hour + 1000);
    state.busy = 'three';
    const fetched = web(state);
    await crawlSite(crawler(), target, base);

    expect(fetched).toContain('/busy');
    expect(fetched).not.toContain('/stable');
  });

  test('isDue doubles the wait for each unchanged check up to the maximum', () => {
    const min = 1000;
    const max = 8000;
    const entry = (unchangedStreak: number) => ({ checkedAt: 0, unchangedStreak });
    expect(isDue(entry(0), 999, min, max)).toBe(false);
    expect(isDue(entry(0), 1000, min, max)).toBe(true);
    expect(isDue(entry(2), 3999, min, max)).toBe(false);
    expect(isDue(entry(2), 4000, min, max)).toBe(true);
    expect(isDue(entry(20), 7999, min, max)).toBe(false);
    expect(isDue(entry(20), 8000, min, max)).toBe(true);
    expect(isDue(undefined, 0, min, max)).toBe(true);
  });
});

describe('a broken store never breaks the crawl', () => {
  test('a store that throws on load and save still crawls', async () => {
    const store: CrawlStore = {
      load: () => {
        throw new Error('down');
      },
      save: () => {
        throw new Error('down');
      },
    };
    web();
    const run = await crawlSite(crawler(), target, { ...opts, store, maxPages: 20 });
    expect(run.pages.length).toBe(6);
  });
});
