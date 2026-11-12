import { describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { crawlSite } from '@/crawl-site';
import type { CrawlTarget } from '@/core/types';
import { publicDns } from '../helpers';

// CRAWL-BUDGET-1: maxPages bounds the fetches of a run, whether they succeed, fail or repeat.

const target: CrawlTarget = { baseUrl: 'https://budget.example.com', robotsPolicy: 'allow', active: true };
const crawler = () => createCrawler({ userAgent: 'T/1 (+https://t.example/bot)', dnsLookup: publicDns });

describe('the page budget', () => {
  test('failing seeds stop at maxPages and the run reports it was cut short', async () => {
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (new URL(String(input)).pathname === '/robots.txt') return new Response('', { status: 404 });
      calls++;
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    const seeds = Array.from({ length: 20 }, (_, i) => `https://budget.example.com/${i}`);
    const run = await crawlSite(crawler(), target, { seeds, maxPages: 3, maxRetries: 0 });
    expect(run.truncated).toBe(true);
    expect(run.failures.length).toBe(3);
    expect(calls).toBe(3);
  });
});
