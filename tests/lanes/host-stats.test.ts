import { describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { crawlSite } from '@/crawl-site';
import type { CrawlTarget, UsageEvent } from '@/core/types';
import { publicDns } from '../helpers';

// CRAWL-HOST-STATS-1: a run reports how its host behaved, and usage events name the host.

const target: CrawlTarget = { baseUrl: 'https://stats.example.com', robotsPolicy: 'allow', active: true };
const html = (links: string[]) =>
  `<html><head><title>T</title></head><body><main><p>Weekly concerts at the riverside stage all summer long.</p>${links
    .map((l) => `<a href="${l}">x</a>`)
    .join('')}</main></body></html>`;

function web() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
    if (url.pathname === '/') return new Response(html(['/ok', '/gone', '/walled']), { headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/gone') return new Response('missing', { status: 404 });
    if (url.pathname === '/walled') return new Response('no', { status: 403 });
    return new Response(html([]), { headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
}

describe('per-host stats', () => {
  test('counts pages, failure classes and the block rate for the host', async () => {
    web();
    const run = await crawlSite(createCrawler({ userAgent: 'T/1 (+https://t.example/bot)', dnsLookup: publicDns }), target, {
      followLinks: true,
      maxDepth: 1,
      maxPages: 10,
      maxRetries: 0,
    });
    const stats = run.hosts['stats.example.com']!;
    expect(stats.pages).toBe(2);
    expect(stats.attempts).toBe(4);
    expect(stats.failures.structural).toBeGreaterThanOrEqual(1);
    expect(stats.blockRate).toBeGreaterThan(0);
    expect(stats.blockRate).toBeLessThanOrEqual(0.5);
    expect(stats.medianLatencyMs).toBeGreaterThanOrEqual(0);
  });

  test('usage events carry the host', async () => {
    web();
    const events: UsageEvent[] = [];
    const crawler = createCrawler({
      userAgent: 'T/1 (+https://t.example/bot)',
      dnsLookup: publicDns,
      onUsage: (e) => events.push(e),
    });
    await crawlSite(crawler, target, { maxRetries: 0 });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.host === 'stats.example.com')).toBe(true);
  });
});
