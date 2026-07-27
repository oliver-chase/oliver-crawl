import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCrawler } from '@/index';
import { classifyFailure } from '@/core/failure-class';
import { looksLikeEmptyState } from '@/core/soft-404';
import { EXTRACTOR_VERSION } from '@/core/extractor-version';
import { resolveConfig, __clearUserAgentWarningsForTests } from '@/core/config';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import type { CrawlTarget } from '@/core/types';

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const target: CrawlTarget = { baseUrl: 'https://venue.example.com', robotsPolicy: 'allow', active: true };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
  __clearUserAgentWarningsForTests();
  vi.restoreAllMocks();
});

// CRAWL-DEGRADE-1 — one bit: is retrying worth it?
describe('failure classification', () => {
  test('policy decisions are structural — retrying re-makes the same decision', () => {
    expect(classifyFailure('blocked', 'Target is inactive')).toBe('structural');
    expect(classifyFailure('quarantined', 'injection signals')).toBe('structural');
    expect(classifyFailure('no_lane_available', 'no key')).toBe('structural');
  });

  test('transport trouble is transient', () => {
    expect(classifyFailure('unreachable', 'ECONNRESET')).toBe('transient');
    expect(classifyFailure('unreachable', 'The operation timed out')).toBe('transient');
    expect(classifyFailure('unreachable', 'HTTP 503 from origin')).toBe('transient');
  });

  test('a page that is genuinely gone is structural', () => {
    expect(classifyFailure('unreachable', 'HTTP 404 Not Found')).toBe('structural');
    expect(classifyFailure('unreachable', 'HTTP 410 Gone')).toBe('structural');
  });

  test('a 403 is TRANSIENT — it is a bot wall far more often than a refusal', () => {
    // Treating 403 as structural would retire sources that work next run.
    expect(classifyFailure('unreachable', 'HTTP 403 Forbidden')).toBe('transient');
  });

  test('an unsupported content-type will never become supported', () => {
    expect(classifyFailure('empty', 'Unsupported content-type: image/png')).toBe('structural');
  });

  test('a page that rendered nothing today may render something tomorrow', () => {
    expect(classifyFailure('empty', 'No visible text in the served HTML')).toBe('transient');
  });

  test('a missing optional parser is structural — it needs an install, not a wait', () => {
    expect(
      classifyFailure('empty', 'PDF support needs the optional `unpdf` package. Run `npm install unpdf` to enable it.'),
    ).toBe('structural');
  });

  test('a PDF with no text layer is structural — it needs a vision model', () => {
    expect(classifyFailure('empty', 'PDF has no text layer (likely scanned images)')).toBe('structural');
  });

  test('a real crawl failure carries the class', async () => {
    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns });
    const result = await crawler.crawl({ ...target, active: false }, 'https://venue.example.com/x');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.failureClass).toBe('structural');
  });
});

// BETTER-SOFT404-1 — advisory only, never filters
describe('empty-state detection', () => {
  test.each([
    'No events scheduled at this time.',
    'There are no upcoming shows.',
    'Nothing scheduled. Check back soon!',
    'Page under construction.',
    'Coming soon.',
    'Page not found.',
  ])('flags %j', (text) => {
    expect(looksLikeEmptyState(text)).toBe(true);
  });

  test('a page with essentially no text is flagged', () => {
    expect(looksLikeEmptyState('   ')).toBe(true);
  });

  test('a real listing is NOT flagged', () => {
    expect(
      looksLikeEmptyState(
        'The summer concert series runs every Friday evening at the riverside stage. ' +
          'July 11 brings The Hold Steady, and July 18 brings Waxahatchee. Doors at six.',
      ),
    ).toBe(false);
  });

  test('a long page mentioning "coming soon" in passing is NOT flagged', () => {
    // The signal is an empty-state phrase AND nothing else on the page.
    const long =
      'Our autumn programme is now open for booking with a full slate of touring acts. '.repeat(10) +
      'A winter season is coming soon.';
    expect(looksLikeEmptyState(long)).toBe(false);
  });

  test('the flag rides on the page, which is still returned in full', async () => {
    globalThis.fetch = (async () =>
      new Response(
        '<html><head><title>Events</title></head><body><main><p>No events scheduled at this time.</p></main></body></html>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      )) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://venue.example.com/events');

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.likelyEmptyState).toBe(true);
    // Advisory: an off-season venue really IS "no events", and that is a fact
    // a consumer may want to record.
    expect(result.pages[0]!.text).toContain('No events scheduled');
  });
});

// CRAWL-CONTENTKIND-1 — so an extractor improvement can reach old pages
describe('extractor version', () => {
  test('every page is stamped', async () => {
    globalThis.fetch = (async () =>
      new Response(
        '<html><head><title>T</title></head><body><main><p>Concerts every Friday at the riverside stage.</p></main></body></html>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      )) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://venue.example.com/x');

    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.extractorVersion).toBe(EXTRACTOR_VERSION);
    expect(EXTRACTOR_VERSION).toBeTruthy();
  });
});

// CRAWL-UA-1 — warn, never throw
describe('user-agent contact warning', () => {
  test('warns when the user agent has no contact', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveConfig({ userAgent: 'AnonymousBot/1.0' });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('no contact URL');
  });

  test('stays quiet when a contact URL is present', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveConfig({ userAgent: 'MyBot/1.0 (+https://mysite.com/bot)' });
    expect(warn).not.toHaveBeenCalled();
  });

  test('warns once per user agent, not once per crawler', () => {
    // A 500-page run must not print 500 warnings.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveConfig({ userAgent: 'AnonymousBot/1.0' });
    resolveConfig({ userAgent: 'AnonymousBot/1.0' });
    resolveConfig({ userAgent: 'AnonymousBot/1.0' });
    expect(warn).toHaveBeenCalledOnce();
  });

  test('never throws — a caller may have a reason', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => resolveConfig({ userAgent: 'AnonymousBot/1.0' })).not.toThrow();
  });
});
