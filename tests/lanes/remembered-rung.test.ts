import { describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import type { CrawlTarget } from '@/core/types';
import { publicDns } from '../helpers';

// A remembered rung that stops working falls back to the direct fetch, and each rung runs once for that crawl.

const target: CrawlTarget = { baseUrl: 'https://mem.example.com', robotsPolicy: 'allow', active: true };
const JINA_BODY =
  'Title: Recovered\nURL Source: https://mem.example.com/x\n\nMarkdown Content:\n' +
  'Outdoor concert series every Friday at Example Park, doors at six, free admission. '.repeat(4);

describe('a remembered rung that fails', () => {
  test('the reader rung runs once for the failing crawl', async () => {
    let jinaWorks = true;
    let jinaCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'r.jina.ai') {
        jinaCalls++;
        return jinaWorks ? new Response(JINA_BODY, { status: 200 }) : new Response('down', { status: 503 });
      }
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      return new Response('blocked', { status: 403 });
    }) as typeof fetch;
    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example/bot)', dnsLookup: publicDns });
    const first = await crawler.crawl(target, 'https://mem.example.com/x', { retries: 0 });
    expect(first.ok).toBe(true);

    jinaWorks = false;
    jinaCalls = 0;
    const second = await crawler.crawl(target, 'https://mem.example.com/y', { retries: 0 });
    expect(second.ok).toBe(false);
    expect(jinaCalls).toBe(1);
  });
});
