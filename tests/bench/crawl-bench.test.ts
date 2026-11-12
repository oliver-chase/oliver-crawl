import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { crawlSites } from '@/crawl-site';
import { createMemoryCrawlStore } from '@/crawl-store';
import type { CrawlTarget } from '@/core/types';
import { publicDns } from '../helpers';

// A fixed multi-host crawl and recrawl whose request and byte counts are checked against a
// recorded baseline, so a change that makes the crawler do more work fails `npm run check`.
// `npm run bench` prints the same run with pages per second.

const HOSTS = 6;
const PAGES = 20;
const BASELINE = new URL('./baseline.json', import.meta.url);

const body = (host: string, n: number) =>
  `<html><head><title>${host} page ${n}</title></head><body><main><h1>Page ${n} on ${host}</h1>` +
  `<p>${`Weekly concerts at the riverside stage number ${n} on ${host} all summer long. `.repeat(12)}</p>` +
  Array.from({ length: PAGES }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('') +
  `</main></body></html>`;

type Counts = { requests: number; notModified: number; bytes: number };

/** A fake web of HOSTS origins with PAGES pages each. Pages carry an ETag and answer 304 to it. */
function web() {
  const counts: Counts = { requests: 0, notModified: 0, bytes: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
    counts.requests++;
    const n = url.pathname === '/' ? 0 : Number(url.pathname.slice(2));
    const etag = `"${url.hostname}-${n}"`;
    const headers = new Headers(init?.headers);
    if (headers.get('if-none-match') === etag) {
      counts.notModified++;
      return new Response(null, { status: 304, headers: { etag } });
    }
    const text = body(url.hostname, n);
    counts.bytes += text.length;
    return new Response(text, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', etag } });
  }) as typeof fetch;
  return counts;
}

const targets = (): CrawlTarget[] =>
  Array.from({ length: HOSTS }, (_, i) => ({ baseUrl: `https://host${i}.example.com`, robotsPolicy: 'allow', active: true }));

async function run() {
  const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example/bot)', dnsLookup: publicDns });
  const store = createMemoryCrawlStore();
  const options = {
    followLinks: true,
    maxDepth: 1,
    maxPages: PAGES + 1,
    concurrency: 4,
    perHostConcurrency: 4,
    siteConcurrency: HOSTS,
    store,
    recrawlMinIntervalMs: 1,
  };
  const counts = web();
  const t0 = performance.now();
  const first = await crawlSites(crawler, targets(), options);
  const firstMs = performance.now() - t0;
  const firstCounts = { ...counts };
  const pagesFirst = first.reduce((sum, r) => sum + r.result.pages.length, 0);

  await new Promise((r) => setTimeout(r, 5));
  Object.assign(counts, { requests: 0, notModified: 0, bytes: 0 });
  const t1 = performance.now();
  const second = await crawlSites(crawler, targets(), { ...options, priorValidators: Object.assign({}, ...first.map((r) => r.result.validators)) });
  const secondMs = performance.now() - t1;
  const pagesSecond = second.reduce((sum, r) => sum + r.result.pages.length, 0);
  return { pagesFirst, pagesSecond, firstCounts, secondCounts: { ...counts }, firstMs, secondMs };
}

describe('multi-host crawl benchmark', () => {
  test('the crawl and the recrawl stay within the recorded work', async () => {
    const r = await run();
    if (process.env.BENCH_PRINT) {
      const rate = (pages: number, ms: number) => ((pages / ms) * 1000).toFixed(0);
      console.log(`first crawl: ${r.pagesFirst} pages, ${r.firstCounts.requests} requests, ${r.firstCounts.bytes} bytes, ${rate(r.pagesFirst, r.firstMs)} pages/s`);
      console.log(`recrawl:     ${r.pagesSecond} pages, ${r.secondCounts.requests} requests (${r.secondCounts.notModified} not modified), ${r.secondCounts.bytes} bytes, ${rate(r.secondCounts.requests, r.secondMs)} requests/s`);
    }
    const now = {
      first: { requests: r.firstCounts.requests, bytes: r.firstCounts.bytes },
      recrawl: { requests: r.secondCounts.requests, bytes: r.secondCounts.bytes },
    };
    if (process.env.BENCH_RECORD) writeFileSync(BASELINE, JSON.stringify(now, null, 2) + '\n');
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as typeof now;
    // The root page and /p0 carry the same text, so the near-duplicate check reports one of them.
    expect(r.pagesFirst).toBe(HOSTS * PAGES);
    // A recrawl that asked nothing would pass the ceilings below, so it must revalidate every site.
    expect(r.secondCounts.requests).toBeGreaterThanOrEqual(HOSTS);
    for (const phase of ['first', 'recrawl'] as const) {
      expect(now[phase].requests, `${phase} requests grew past the baseline`).toBeLessThanOrEqual(baseline[phase].requests);
      expect(now[phase].bytes, `${phase} bytes grew past the baseline`).toBeLessThanOrEqual(baseline[phase].bytes);
    }
  });
});
