import { afterEach, describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { extractPdfText } from '@/fetch/pdf-extract';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import type { CrawlTarget } from '@/core/types';

// CRAWL-PDF-1: the parser is an OPTIONAL peer, not a dependency. A PDF parser
// is a large amount of parsing code over hostile input, and putting that in
// every consumer's install — including the majority who never crawl a PDF —
// is the wrong trade for a library whose value is screening what it fetches.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const target: CrawlTarget = { baseUrl: 'https://example.com', robotsPolicy: 'allow', active: true };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
});

describe('without the optional parser installed', () => {
  test('reports the missing package by name, actionably', async () => {
    // `unpdf` is not installed in this repo, so this is the real path a
    // consumer hits — not a simulation of it.
    const result = await extractPdfText(new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected no parser');
    expect(result.reason).toBe('no_parser');
    expect(result.detail).toContain('unpdf');
    expect(result.detail).toContain('npm install');
  });

  test('a crawled PDF fails structurally, naming the fix', async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      })) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://example.com/catalogue.pdf');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    // Structural: installing a package is a fix, and retrying without it
    // will fail identically forever.
    expect(result.failureClass).toBe('structural');
    expect(result.detail).toContain('unpdf');
  });

  test('the crawl does not throw — a missing optional peer degrades', async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      })) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns });
    await expect(crawler.crawl(target, 'https://example.com/x.pdf')).resolves.toBeDefined();
  });
});

describe('a PDF is recognised as its own content kind', () => {
  test('application/pdf is no longer refused outright', async () => {
    // Before CRAWL-PDF-1 this produced "Unsupported content-type". The
    // distinction matters: one says "we will never read this", the other
    // says "install a package and we will".
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      })) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://example.com/x.pdf');

    if (result.ok) throw new Error('expected failure without the parser');
    expect(result.detail).not.toContain('Unsupported content-type');
  });
});
