import { afterEach, describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import { __clearRobotsCacheForTests } from '@/lanes/own/index';
import type { CrawlTarget } from '@/core/types';

// BODY-RECEIVED-1: "the site is down" and "the site served a shell" are the
// same reason and different facts.
//
// A consumer whose rule is never to lose a page wants to RETAIN the second —
// it was read, it had nothing in it, a later parser pass may do better — and
// log the first. Fallow was recovering that distinction by regex-matching the
// detail string, which is the coupling that has silently switched several
// signals off across this fleet. The library knows; it should say.

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

describe('a failure says whether an origin answered', () => {
  test('a JS shell reports bodyReceived', async () => {
    globalThis.fetch = (async () =>
      new Response('<html><head><title>Fest</title></head><body><div id="root"></div></body></html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      })) as typeof fetch;

    const result = await createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns }).crawl(
      target, 'https://site.example.com/',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.bodyReceived, 'a page that WAS read reported no body').toBe(true);
  });

  test('a server error does NOT report bodyReceived', async () => {
    // The other half. Reporting it here would make every outage look like a
    // retainable page, which is worse than not reporting it at all.
    globalThis.fetch = (async () => new Response('down', { status: 503 })) as typeof fetch;

    const result = await createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns }).crawl(
      target, 'https://site.example.com/',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.bodyReceived ?? false).toBe(false);
  });
});
