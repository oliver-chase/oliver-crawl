import { afterEach, describe, expect, test, vi } from 'vitest';
import { pinnedLookup } from '@/fetch/connection-pool';
import { assertHostResolvesToPublicAddress, __clearDnsCacheForTests } from '@/fetch/host-policy';
import { evaluateRobotsForUrl } from '@/fetch/robots-check';
import { probeCheapChangeSignal } from '@/fetch/cheap-change-probe';
import { discoverSitemapUrls } from '@/fetch/sitemap-discovery';
import { discoverPaginatedUrls } from '@/extract/pagination-discovery';
import type { CrawlTarget } from '@/core/types';
import { publicDns } from '../helpers';

// POOL-PIN-1: a connection goes to an address the crawler approved, and every fetch path shares the pool.

const target: CrawlTarget = { baseUrl: 'https://pin.example.com', robotsPolicy: 'allow', active: true };
const privateDns = async () => [{ address: '10.0.0.5', family: 4 }];

const lookup = (resolve = privateDns, host = 'pin.example.com', approvedBy = publicDns) =>
  new Promise<{ error: Error | null; address?: unknown }>((done) => {
    (pinnedLookup(approvedBy, resolve) as (h: string, o: { all: boolean }, cb: (e: Error | null, a?: unknown) => void) => void)(host, { all: true }, (error, address) =>
      done({ error, address }),
    );
  });

afterEach(() => {
  vi.useRealTimers();
  __clearDnsCacheForTests();
});

describe('connections go to approved addresses', () => {
  test('an approved host connects to its approved address, not a later private answer', async () => {
    await assertHostResolvesToPublicAddress('pin.example.com', publicDns);
    const result = await lookup(privateDns);
    expect(result.error).toBeNull();
    expect(result.address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  test('an approval belongs to the resolver that gave it', async () => {
    const other = async () => [{ address: '8.8.8.8', family: 4 }];
    await assertHostResolvesToPublicAddress('pin.example.com', publicDns);
    await assertHostResolvesToPublicAddress('pin.example.com', other);
    expect((await lookup(privateDns, 'pin.example.com', publicDns)).address).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect((await lookup(privateDns, 'pin.example.com', other)).address).toEqual([{ address: '8.8.8.8', family: 4 }]);
  });

  test('a host with no approval that resolves private is refused', async () => {
    const result = await lookup(privateDns);
    expect(result.error?.message).toMatch(/private IPv4/i);
  });

  test('an expired approval falls back to a checked answer', async () => {
    vi.useFakeTimers();
    await assertHostResolvesToPublicAddress('pin.example.com', publicDns);
    vi.advanceTimersByTime(61_000);
    const result = await lookup(privateDns);
    expect(result.error?.message).toMatch(/private IPv4/i);
  });
});

describe('every fetch path uses the pool by default', () => {
  function spy() {
    const dispatchers: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit & { dispatcher?: unknown }) => {
      dispatchers.push(init?.dispatcher);
      return new Response('', { status: 404 });
    }) as typeof fetch;
    return dispatchers;
  }

  const paths: Array<[string, () => Promise<unknown>]> = [
    ['robots', () => evaluateRobotsForUrl('https://pin.example.com/', { dnsLookup: publicDns })],
    ['change probe', () => probeCheapChangeSignal(target, 'https://pin.example.com/', { dnsLookup: publicDns })],
    ['sitemap', () => discoverSitemapUrls(target, { userAgent: 'T/1 (+https://t.example/bot)', dnsLookup: publicDns })],
    ['pagination', () => discoverPaginatedUrls('https://pin.example.com/', { dnsLookup: publicDns })],
  ];

  test.each(paths)('the %s fetch goes through the pool', async (_name, run) => {
    const seen = spy();
    await run();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((d) => d !== undefined)).toBe(true);
  });

  test('an injected fetch is used and the pool is not', async () => {
    const seen = spy();
    const injected = vi.fn(async () => new Response('', { status: 404 }));
    await evaluateRobotsForUrl('https://pin.example.com/', { dnsLookup: publicDns, fetchImpl: injected as unknown as typeof fetch });
    expect(injected).toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});
