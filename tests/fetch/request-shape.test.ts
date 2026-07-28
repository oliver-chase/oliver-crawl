import { afterEach, describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { fetchViaJina } from '@/fetch/jina-fetch';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import type { CrawlTarget } from '@/core/types';

// Decisions that were recorded in the code and asserted nowhere. Each is a
// choice a reader would otherwise simplify away.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const target: CrawlTarget = { baseUrl: 'https://site.example.com', robotsPolicy: 'allow', active: true };
const PAGE =
  '<html><head><title>T</title></head><body><main><p>The catalogue is open for browsing today.</p></main></body></html>';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
});

describe('PARITY-HEADERS-1 — a plausible, honest header set', () => {
  test('sends accept-language, which every real browser does', async () => {
    // Its absence is one of the oldest bot tells, and naive WAF rules key on it.
    let headers: Headers | undefined;
    globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;

    await createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns }).crawl(
      target,
      'https://site.example.com/x',
    );
    expect(headers?.get('accept-language')).toBeTruthy();
    expect(headers?.get('accept')).toContain('text/html');
  });

  test('does NOT claim to be Chrome', async () => {
    // sec-ch-ua next to an honest bot User-Agent is a half-consistent
    // disguise, which is a stronger tell than no disguise at all.
    let headers: Headers | undefined;
    globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;

    await createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns }).crawl(
      target,
      'https://site.example.com/x',
    );
    expect(headers?.get('sec-ch-ua')).toBeNull();
    expect(headers?.get('user-agent')).toBe('T/1 (+https://t.example.com)');
  });
});

describe('JINA-SELFHOST-1 — the reader endpoint is configurable', () => {
  test('defaults to the public reader', async () => {
    let called = '';
    const fetchImpl = (async (u: RequestInfo | URL) => {
      called = String(u);
      return new Response('Title: x\nURL Source: y\n\nMarkdown Content:\nbody', { status: 200 });
    }) as typeof fetch;

    await fetchViaJina('https://site.example.com/x', { fetchImpl });
    expect(called).toContain('r.jina.ai');
  });

  test('a configured endpoint replaces it, so a free rung is not one vendor’s uptime', async () => {
    let called = '';
    const fetchImpl = (async (u: RequestInfo | URL) => {
      called = String(u);
      return new Response('Title: x\nURL Source: y\n\nMarkdown Content:\nbody', { status: 200 });
    }) as typeof fetch;

    await fetchViaJina('https://site.example.com/x', { fetchImpl, endpoint: 'https://reader.internal/' });
    expect(called).toContain('reader.internal');
    expect(called).not.toContain('r.jina.ai');
  });
});

describe('CRAWL-BACKOFF-1 — the origin’s schedule beats ours', () => {
  test('Retry-After is surfaced so a retry honours it', async () => {
    // Our own backoff is a guess; the origin's is an instruction, and
    // ignoring it is what gets a crawler banned.
    globalThis.fetch = (async (u: RequestInfo | URL) =>
      String(u).includes('r.jina.ai')
        ? new Response('', { status: 500 })
        : new Response('slow down', { status: 429, headers: { 'retry-after': '120' } })) as typeof fetch;

    const r = await createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns }).crawl(
      target,
      'https://site.example.com/x',
    );

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.retryAfterMs).toBe(120_000);
  });
});
