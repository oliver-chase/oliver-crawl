import { describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { crawlSite } from '@/crawl-site';
import { createNearDuplicateIndex, hammingDistance, simhash } from '@/extract/near-duplicate';
import type { CrawlTarget } from '@/core/types';
import { publicDns } from '../helpers';

// CRAWL-NEARDUP-1: the same content under another URL is reported once and not returned again.

const ARTICLE = Array.from(
  { length: 12 },
  (_, i) => `Paragraph ${i} explains how tidal creeks shelter young fish while marsh grass slows storm surge before it reaches the town.`,
).join(' ');
const OTHER = Array.from(
  { length: 12 },
  (_, i) => `Item ${i} covers the quarterly budget for the library branch, covering staffing, repairs and the new reading room furniture.`,
).join(' ');

describe('simhash', () => {
  test('is stable and 16 hex characters', () => {
    expect(simhash(ARTICLE)).toMatch(/^[0-9a-f]{16}$/);
    expect(simhash(ARTICLE)).toBe(simhash(ARTICLE));
  });

  test('puts a lightly edited copy within a few bits and an unrelated page far away', () => {
    const edited = ARTICLE.replace('Paragraph 3', 'Section 3');
    expect(hammingDistance(simhash(ARTICLE), simhash(edited))).toBeLessThanOrEqual(3);
    expect(hammingDistance(simhash(ARTICLE), simhash(OTHER))).toBeGreaterThan(10);
  });

  test('gives a short page no fingerprint', () => {
    expect(simhash('Opening hours are nine to five.')).toBe('');
  });
});

describe('the index', () => {
  test('finds a near twin and records only the first', () => {
    const index = createNearDuplicateIndex(3);
    expect(index.check('/a', simhash(ARTICLE))).toBeNull();
    expect(index.check('/b', simhash(OTHER))).toBeNull();
    expect(index.check('/c', simhash(ARTICLE.replace('Paragraph 3', 'Section 3')))).toMatchObject({ of: '/a' });
  });

  test('a wider distance still finds a match', () => {
    const index = createNearDuplicateIndex(8);
    index.check('/a', simhash(ARTICLE));
    expect(index.check('/c', simhash(ARTICLE.replace(/Paragraph (\d)/g, 'Part $1')))).toMatchObject({ of: '/a' });
  });

  test('an empty fingerprint is never a duplicate', () => {
    const index = createNearDuplicateIndex(3);
    expect(index.check('/a', '')).toBeNull();
    expect(index.check('/b', '')).toBeNull();
  });
});

const target: CrawlTarget = { baseUrl: 'https://dup.example.com', robotsPolicy: 'allow', active: true };
const doc = (body: string, links: string[] = []) =>
  `<html><head><title>T</title></head><body><main><p>${body}</p>${links.map((l) => `<a href="${l}">x</a>`).join('')}</main></body></html>`;

describe('crawlSite and near-duplicates', () => {
  function web() {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      const body =
        url.pathname === '/'
          ? doc('Home of the marshes. ' + OTHER, ['/story', '/story-print', '/other'])
          : url.pathname === '/other'
            ? doc(OTHER.replace('Item 2', 'Entry 2') + ' different tail words here')
            : doc(url.pathname === '/story-print' ? ARTICLE.replace('Paragraph 3', 'Section 3') : ARTICLE);
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }) as typeof fetch;
  }
  const crawler = () => createCrawler({ userAgent: 'T/1 (+https://t.example/bot)', dnsLookup: publicDns });

  test('reports the print view as a duplicate of the story', async () => {
    web();
    const run = await crawlSite(crawler(), target, { followLinks: true, maxDepth: 1, maxPages: 10 });
    expect(run.duplicates.map((d) => d.url)).toEqual(['https://dup.example.com/story-print']);
    expect(run.duplicates[0]!.of).toBe('https://dup.example.com/story');
    expect(run.pages.map((p) => new URL(p.url).pathname).sort()).toEqual(['/', '/other', '/story'].sort());
  });

  test('keeps the duplicate page when the check is off', async () => {
    web();
    const run = await crawlSite(crawler(), target, { followLinks: true, maxDepth: 1, maxPages: 10, nearDuplicateDistance: -1 });
    expect(run.duplicates).toEqual([]);
    expect(run.pages.some((p) => p.url.endsWith('/story-print'))).toBe(true);
  });
});
