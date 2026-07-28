import { afterEach, describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import { __clearRobotsCacheForTests } from '@/lanes/own/index';
import type { CrawlPage, CrawlTarget } from '@/core/types';

// PAGE-SHAPE-1: every rung must return a COMPLETE and self-consistent page.
//
// Written after a refactor routed four rungs through one constructor and
// silently dropped `markdown` on the paid lane. 600 tests stayed green,
// because they asserted that rungs returned pages — never what was IN them.
// A missing field surfaces as worse extraction, blamed on the sites.
//
// Each rung below is driven end to end and checked against the same contract,
// so a change to any constructor fails here rather than in a consumer.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const target: CrawlTarget = { baseUrl: 'https://site.example.com', robotsPolicy: 'allow', active: true };

const HTML =
  '<html><head><title>Catalogue</title></head><body><nav><a href="/x">Nav</a></nav>' +
  '<main><h2>Products</h2><p>The full catalogue with supplier details and weekly additions.</p>' +
  '<a href="/item/1">First item detail page</a></main></body></html>';

const JINA_BODY =
  'Title: Catalogue\nURL Source: https://site.example.com/x\n\nMarkdown Content:\n' +
  'The full catalogue with supplier details and weekly additions. '.repeat(4);

const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'SUMMARY:A listing', 'END:VCALENDAR'].join('\n');

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
  __clearRobotsCacheForTests();
});

/**
 * The contract every page satisfies regardless of which rung produced it.
 *
 * `derivedFromHtml` is the axis that actually varies: a rung that parsed HTML
 * can offer structure, one that received prose cannot. The honesty rule is
 * that the second reports empty rather than faking it — a rung change must
 * never look like a content change.
 */
function assertPageShape(page: CrawlPage, expected: { rung: string; lane: string; derivedFromHtml: boolean }) {
  // Identity and provenance
  expect(typeof page.url).toBe('string');
  expect(page.url.length).toBeGreaterThan(0);
  expect(page.rung).toBe(expected.rung);
  expect(page.lane).toBe(expected.lane);
  expect(page.extractorVersion).toBeTruthy();

  // Content: text is the universal field, always present on a successful page.
  expect(typeof page.text).toBe('string');
  expect(page.text.length).toBeGreaterThan(0);

  // The always-comparable change signal. Empty here would silently disable
  // unchanged-detection for this rung.
  expect(page.textSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(page.bodySha256).toMatch(/^[a-f0-9]{64}$/);

  // Fields that must exist as the right TYPE even when empty — a consumer
  // iterating them must not have to null-check per rung.
  expect(Array.isArray(page.jsonLd)).toBe(true);
  expect(Array.isArray(page.links)).toBe(true);
  expect(Array.isArray(page.outboundHosts)).toBe(true);
  expect(Array.isArray(page.candidateContentImages)).toBe(true);
  expect(typeof page.likelyEmptyState).toBe('boolean');
  expect(page.structuredData).toBeDefined();
  expect(Array.isArray(page.structuredData.contentTypes)).toBe(true);
  expect(typeof page.structuredData.hasContentData).toBe('boolean');

  if (expected.derivedFromHtml) {
    // Structure was available, so it must be delivered.
    expect(page.markdown.length).toBeGreaterThan(0);
    expect(page.contentRegionSha256).toMatch(/^[a-f0-9]{64}$/);
  } else {
    // No HTML to derive from: empty rather than faked (CRAWL-HASH-1).
    expect(page.contentRegionSha256).toBe('');
  }
}

function serve(handler: (url: string) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL) => handler(String(input))) as typeof fetch;
}

const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

describe('every rung returns a complete page', () => {
  test('fetch (HTML)', async () => {
    serve(() => html(HTML));
    const r = await createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns }).crawl(
      target,
      'https://site.example.com/x',
    );
    if (!r.ok || r.notModified) throw new Error('expected pages');
    assertPageShape(r.pages[0]!, { rung: 'fetch', lane: 'own', derivedFromHtml: true });
    // HTML rungs additionally carry what only HTML can give.
    expect(r.pages[0]!.title).toBe('Catalogue');
    expect(r.pages[0]!.links.length).toBeGreaterThan(0);
  });

  test('fetch (calendar document)', async () => {
    serve(() => new Response(ICS, { status: 200, headers: { 'content-type': 'text/calendar' } }));
    const r = await createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns }).crawl(
      target,
      'https://site.example.com/events.ics',
    );
    if (!r.ok || r.notModified) throw new Error('expected pages');
    assertPageShape(r.pages[0]!, { rung: 'fetch', lane: 'own', derivedFromHtml: false });
    expect(r.pages[0]!.contentKind).toBe('calendar');
  });

  test('jina', async () => {
    serve((url) => (url.includes('r.jina.ai') ? new Response(JINA_BODY, { status: 200 }) : new Response('no', { status: 403 })));
    const r = await createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns }).crawl(
      target,
      'https://site.example.com/x',
    );
    if (!r.ok || r.notModified) throw new Error('expected pages');
    assertPageShape(r.pages[0]!, { rung: 'jina', lane: 'own', derivedFromHtml: false });
  });

  test('browser-render', async () => {
    serve((url) =>
      url.includes('render.example.com')
        ? new Response(JSON.stringify({ html: HTML }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('no', { status: 403 }),
    );
    const r = await createCrawler({
      userAgent: 'T/1 (+https://t.example.com)',
      dnsLookup: publicDns,
      browserRender: { url: 'https://render.example.com' },
    }).crawl(target, 'https://site.example.com/x');
    if (!r.ok || r.notModified) throw new Error('expected pages');
    assertPageShape(r.pages[0]!, { rung: 'browser-render', lane: 'own', derivedFromHtml: true });
  });

  test('archive', async () => {
    serve((url) => {
      if (url.includes('/cdx/search/cdx')) {
        return new Response(JSON.stringify([['timestamp', 'original'], ['20260601120000', 'https://site.example.com/x']]), { status: 200 });
      }
      if (url.includes('web.archive.org/web/')) return html(HTML);
      if (url.includes('r.jina.ai')) return new Response('', { status: 500 });
      throw new Error('ECONNREFUSED');
    });
    const r = await createCrawler({
      userAgent: 'T/1 (+https://t.example.com)',
      dnsLookup: publicDns,
      useArchiveFallback: true,
    }).crawl(target, 'https://site.example.com/x');
    if (!r.ok || r.notModified) throw new Error('expected pages');
    assertPageShape(r.pages[0]!, { rung: 'archive', lane: 'own', derivedFromHtml: true });
  });

  test('vendor', async () => {
    // The rung whose dropped field prompted this file.
    serve((url) =>
      url.includes('api.firecrawl.dev')
        ? new Response(JSON.stringify({ data: { markdown: '## Catalogue\n\nSupplier details and weekly additions.' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response('no', { status: 403 }),
    );
    const r = await createCrawler({
      userAgent: 'T/1 (+https://t.example.com)',
      dnsLookup: publicDns,
      vendor: { firecrawl: 'fc-key-long-enough' },
    }).crawl(target, 'https://site.example.com/x', { lanes: ['vendor'] });

    if (!r.ok || r.notModified) throw new Error('expected pages');
    const page = r.pages[0]!;
    assertPageShape(page, { rung: 'firecrawl', lane: 'vendor', derivedFromHtml: false });
    // Vendors are ASKED for markdown, so theirs must be populated even though
    // no HTML was parsed here.
    expect(page.markdown.length).toBeGreaterThan(0);
    expect(page.markdown).toBe(page.text);
  });
});
