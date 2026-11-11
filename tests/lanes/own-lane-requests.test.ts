import { describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import type { CrawlTarget, UsageEvent } from '@/core/types';
import { publicDns } from '../helpers';

// The own lane end-to-end, against a stubbed network. Everything here is
// offline and deterministic: fetch and DNS are both injected/stubbed, so
// these assert OUR logic (policy, parsing, guarding, lane selection) rather
// than the reachability of any real site.

const target: CrawlTarget = {
  name: 'Example Venue',
  baseUrl: 'https://venue.example.com',
  robotsPolicy: 'allow',
  active: true,
};

function htmlResponse(body: string, init: { status?: number; headers?: Record<string, string>; url?: string } = {}) {
  const response = new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/html', ...(init.headers ?? {}) },
  });
  if (init.url) Object.defineProperty(response, 'url', { value: init.url });
  return response;
}

describe('conditional GET — validators are actually sent (CRAWL-VALIDATE-1)', () => {
  // The original bug: options accepted etag/lastModified and the 304 branch
  // existed, but no If-None-Match / If-Modified-Since ever went on the wire —
  // the 304 test passed only because its stub returned 304 unconditionally.
  // This asserts the REQUEST, which is the half that was dead.
  test('sends If-None-Match and If-Modified-Since from options', async () => {
    let seen: Record<string, string> = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      );
      return new Response(null, { status: 304 });
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://venue.example.com/events', {
      etag: 'W/"abc"',
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
    });

    expect(seen['if-none-match']).toBe('W/"abc"');
    expect(seen['if-modified-since']).toBe('Wed, 01 Jan 2025 00:00:00 GMT');
    expect(result).toMatchObject({ ok: true, notModified: true });
  });

  test('sends no conditional headers when no validators are given', async () => {
    let seen: Record<string, string> = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      );
      return htmlResponse('<html><body><p>Fresh fetch content.</p></body></html>');
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });
    await crawler.crawl(target, 'https://venue.example.com/events');

    expect(seen['if-none-match']).toBeUndefined();
    expect(seen['if-modified-since']).toBeUndefined();
  });
});

describe('body size cap (CRAWL-HARDEN-1)', () => {
  test('the configured byte cap stops the read, so text past it never arrives', async () => {
    const filler = '<p>Every Friday evening the riverside market hosts local vendors and live music for the whole town.</p>';
    const head = '<html><head><title>Big</title></head><body><main><p>Real event content first.</p>';
    const tail = '<p>TAIL-MARKER</p></main></body></html>';
    const bytes = new TextEncoder().encode(head + filler.repeat(2_000) + tail);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = bytes.subarray(pulled, pulled + 8_192);
        pulled += chunk.byteLength;
        if (chunk.byteLength === 0) controller.close();
        else controller.enqueue(chunk);
      },
    });
    globalThis.fetch = (async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns, limits: { maxBodyBytes: 50_000 } });
    const result = await crawler.crawl(target, 'https://venue.example.com/events');

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.text).toContain('Real event content first.');
    expect(result.pages[0]!.text).not.toContain('TAIL-MARKER');
    expect(pulled).toBeLessThan(100_000);
  });
});

describe('autoRobots — the crawler governs itself (CRAWL-ROBOTS-1)', () => {
  // robots.txt was ported but nothing called it: the lane trusted whatever
  // posture the caller set, so "governed" was only as good as their
  // bookkeeping. With autoRobots on, an unknown posture is resolved for real.
  const unknownTarget: CrawlTarget = { name: 'V', baseUrl: 'https://venue.example.com', active: true };

  test('unknown posture + autoRobots off = fails closed, no robots fetch', async () => {
    let robotsFetched = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('robots.txt')) robotsFetched = true;
      return htmlResponse('<html><body><p>x</p></body></html>');
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'TestBot/1.0', dnsLookup: publicDns });
    const result = await crawler.crawl(unknownTarget, 'https://venue.example.com/events');

    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
    expect(robotsFetched).toBe(false);
  });

  test('autoRobots resolves an allowing robots.txt and proceeds', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('robots.txt')) {
        return new Response('User-agent: *\nDisallow: /admin', { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      return htmlResponse('<html><body><main><p>Real page content.</p></main></body></html>');
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'TestBot/1.0', dnsLookup: publicDns, autoRobots: true });
    const result = await crawler.crawl(unknownTarget, 'https://venue.example.com/events');

    expect(result.ok).toBe(true);
  });

  test('autoRobots honours a site-wide disallow', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('robots.txt')) {
        return new Response('User-agent: *\nDisallow: /', { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      return htmlResponse('<html><body><p>should not be reached</p></body></html>');
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'TestBot/1.0', dnsLookup: publicDns, autoRobots: true });
    const result = await crawler.crawl(unknownTarget, 'https://venue.example.com/events');

    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
  });

  test('robots.txt is fetched once per HOST, not once per page', async () => {
    let robotsFetches = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('robots.txt')) {
        robotsFetches++;
        return new Response('User-agent: *\nDisallow:', { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      return htmlResponse('<html><body><main><p>Page content here.</p></main></body></html>');
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'TestBot/1.0', dnsLookup: publicDns, autoRobots: true });
    await crawler.crawl(unknownTarget, 'https://venue.example.com/a');
    await crawler.crawl(unknownTarget, 'https://venue.example.com/b');
    await crawler.crawl(unknownTarget, 'https://venue.example.com/c');

    expect(robotsFetches).toBe(1);
  });

  test('an explicit posture is never overridden by autoRobots', async () => {
    let robotsFetched = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('robots.txt')) robotsFetched = true;
      return htmlResponse('<html><body><main><p>Allowed by the caller.</p></main></body></html>');
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'TestBot/1.0', dnsLookup: publicDns, autoRobots: true });
    // Caller already knows the posture — their bookkeeping stays the truth.
    const result = await crawler.crawl({ ...unknownTarget, robotsPolicy: 'allow' }, 'https://venue.example.com/x');

    expect(result.ok).toBe(true);
    expect(robotsFetched).toBe(false);
  });
});
