import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createCrawler } from '@/index';
import { createRungMemory, rememberWinningRung, recallWinningRung, RUNG_MEMORY_TTL_MS } from '@/core/rung-memory';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import type { CrawlTarget } from '@/core/types';

// BETTER-RUNGMEMORY-1: a host that always rejects the plain fetch cost a
// guaranteed wasted request on EVERY page. A stateless per-call vendor API
// cannot fix that; running in-process, we can.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };

const JINA_BODY =
  'Title: Recovered\nURL Source: https://venue.example.com/x\n\nMarkdown Content:\n' +
  'Summer concert series every Friday at Riverside Park, doors at six, free admission. '.repeat(4);

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
  vi.useRealTimers();
});

describe('the memory store itself', () => {
  test('recalls a remembered rung', () => {
    const memory = createRungMemory();
    rememberWinningRung(memory, 'venue.example.com', 'jina');
    expect(recallWinningRung(memory, 'venue.example.com')).toBe('jina');
  });

  test('is case-insensitive on host', () => {
    const memory = createRungMemory();
    rememberWinningRung(memory, 'Venue.Example.COM', 'jina');
    expect(recallWinningRung(memory, 'venue.example.com')).toBe('jina');
  });

  test('returns null for an unknown host', () => {
    expect(recallWinningRung(createRungMemory(), 'unknown.example.com')).toBeNull();
  });

  test('expires, so a site that stops blocking is not pinned forever', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T12:00:00Z'));
    const memory = createRungMemory();
    rememberWinningRung(memory, 'venue.example.com', 'jina');

    vi.setSystemTime(Date.now() + RUNG_MEMORY_TTL_MS + 1000);
    expect(recallWinningRung(memory, 'venue.example.com')).toBeNull();
  });

  test('two stores never see each other', () => {
    // The HOST-CACHE-SCOPE-1 lesson: a different User-Agent genuinely gets
    // different answers, so one crawler's observation is not evidence about
    // another's.
    const a = createRungMemory();
    const b = createRungMemory();
    rememberWinningRung(a, 'venue.example.com', 'jina');
    expect(recallWinningRung(b, 'venue.example.com')).toBeNull();
  });
});

describe('a blocked host skips the wasted fetch next time', () => {
  function stub() {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('r.jina.ai')) {
        calls.push('jina');
        return new Response(JINA_BODY, { status: 200 });
      }
      calls.push('fetch');
      return new Response('Forbidden', { status: 403 });
    }) as typeof fetch;
    return calls;
  }

  test('the second page on a known-blocked host does not re-try the fetch', async () => {
    const calls = stub();
    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns });

    await crawler.crawl(target, 'https://venue.example.com/one');
    expect(calls).toEqual(['fetch', 'jina']);

    calls.length = 0;
    await crawler.crawl(target, 'https://venue.example.com/two');

    // The wasted 403 is gone — straight to the rung that works.
    expect(calls).toEqual(['jina']);
  });

  test('a crawler with rungMemory: false re-probes every time', async () => {
    const calls = stub();
    const crawler = createCrawler({
      userAgent: 'T/1 (+https://t.example.com)',
      dnsLookup: publicDns,
      rungMemory: false,
    });

    await crawler.crawl(target, 'https://venue.example.com/one');
    calls.length = 0;
    await crawler.crawl(target, 'https://venue.example.com/two');

    expect(calls).toEqual(['fetch', 'jina']);
  });

  test('a separate crawler starts with no memory', async () => {
    const calls = stub();
    const first = createCrawler({ userAgent: 'A/1 (+https://a.example.com)', dnsLookup: publicDns });
    await first.crawl(target, 'https://venue.example.com/one');

    calls.length = 0;
    const second = createCrawler({ userAgent: 'B/1 (+https://b.example.com)', dnsLookup: publicDns });
    await second.crawl(target, 'https://venue.example.com/two');

    // Different identity, different answers possible — it must probe itself.
    expect(calls).toEqual(['fetch', 'jina']);
  });

  test('a host where the plain fetch WORKS is never skipped', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async () => {
      calls.push('fetch');
      return new Response(
        '<html><head><title>T</title></head><body><main><p>Concerts every Friday at the riverside stage.</p></main></body></html>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns });
    await crawler.crawl(target, 'https://venue.example.com/one');
    calls.length = 0;
    await crawler.crawl(target, 'https://venue.example.com/two');

    expect(calls).toEqual(['fetch']);
  });

  test('a stale memory self-heals instead of losing the page', async () => {
    // The host stops blocking AND the remembered rung goes down. Without
    // self-healing this costs the PAGE: we skip the fetch that would now
    // work, jina fails, and there is nothing left.
    let blocking = true;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('r.jina.ai')) {
        return blocking ? new Response(JINA_BODY, { status: 200 }) : new Response('', { status: 500 });
      }
      return blocking
        ? new Response('Forbidden', { status: 403 })
        : new Response(
            '<html><head><title>T</title></head><body><main><p>Concerts every Friday at the riverside stage.</p></main></body></html>',
            { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
          );
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns });
    await crawler.crawl(target, 'https://venue.example.com/one');

    blocking = false;
    const result = await crawler.crawl(target, 'https://venue.example.com/two');

    // Memory said jina; jina failed; the memory was dropped and the plain
    // fetch — now working — was tried. The page survives.
    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('stale memory lost the page');
    expect(result.pages[0]!.rung).toBe('fetch');
  });

  test('a policy refusal does not wipe the memory', async () => {
    // 'blocked' is a decision we made, not evidence the host changed.
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('r.jina.ai')) {
        calls.push('jina');
        return new Response(JINA_BODY, { status: 200 });
      }
      calls.push('fetch');
      return new Response('Forbidden', { status: 403 });
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns });
    await crawler.crawl(target, 'https://venue.example.com/one');

    calls.length = 0;
    await crawler.crawl(target, 'https://venue.example.com/two');
    expect(calls).toEqual(['jina']);
  });
});
