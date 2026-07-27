import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCrawler } from '@/index';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearRobotsCacheForTests } from '@/lanes/own/index';
import type { CrawlTarget, UsageEvent } from '@/core/types';

// The own lane end-to-end, against a stubbed network. Everything here is
// offline and deterministic: fetch and DNS are both injected/stubbed, so
// these assert OUR logic (policy, parsing, guarding, lane selection) rather
// than the reachability of any real site.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

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

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearRobotsCacheForTests();
  vi.restoreAllMocks();
});

describe('own lane — happy path', () => {
  test('extracts text, title, JSON-LD, links and hashes', async () => {
    globalThis.fetch = (async () =>
      htmlResponse(
        `<html><head><title>Summer Series</title>
         <script type="application/ld+json">{"@type":"Event","name":"Night One"}</script>
         </head><body>
         <main><h1>Summer Series</h1><p>Every Friday at the park.</p>
         <a href="/events/night-one">Night One</a>
         <a href="https://tickets.example.net/buy">Tickets</a></main>
         <script>window.__DATA__ = 1;</script>
         </body></html>`,
        { headers: { etag: 'W/"abc"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' } },
      )) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'TestBot/1.0', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://venue.example.com/events');

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');

    const page = result.pages[0]!;
    expect(page.title).toBe('Summer Series');
    expect(page.text).toContain('Every Friday at the park.');
    // <script> content must never leak into the text handed downstream.
    expect(page.text).not.toContain('__DATA__');
    expect(page.jsonLd).toHaveLength(1);
    expect(page.links.map((l) => l.url)).toContain('https://venue.example.com/events/night-one');
    expect(page.outboundHosts).toContain('tickets.example.net');
    expect(page.httpEtag).toBe('W/"abc"');
    expect(page.bodySha256).toMatch(/^[0-9a-f-]{16,}$/);
    expect(page.contentRegionSha256).toBeTruthy();
    expect(page.lane).toBe('own');
    expect(page.rung).toBe('fetch');
  });

  test('a 304 ends the crawl for free, distinctly from empty', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 304 })) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'TestBot/1.0', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://venue.example.com/events', {
      etag: 'W/"abc"',
    });

    expect(result).toMatchObject({ ok: true, notModified: true });
    if (!result.ok) throw new Error('expected ok');
    expect(result.pages).toHaveLength(0);
  });

  test('reports usage for a successful fetch at zero cost', async () => {
    globalThis.fetch = (async () => htmlResponse('<html><body><p>Some real content here.</p></body></html>')) as typeof fetch;

    const events: UsageEvent[] = [];
    const crawler = createCrawler({ userAgent: 'TestBot/1.0', dnsLookup: publicDns, onUsage: (e) => events.push(e) });
    await crawler.crawl(target, 'https://venue.example.com/events');

    const fetchEvent = events.find((e) => e.rung === 'fetch');
    expect(fetchEvent).toMatchObject({ lane: 'own', ok: true, costUsd: 0 });
  });

  test('a throwing usage sink never breaks the crawl', async () => {
    globalThis.fetch = (async () => htmlResponse('<html><body><p>Content survives a broken logger.</p></body></html>')) as typeof fetch;

    const crawler = createCrawler({
      userAgent: 'TestBot/1.0',
      dnsLookup: publicDns,
      onUsage: () => {
        throw new Error('sink exploded');
      },
    });

    const result = await crawler.crawl(target, 'https://venue.example.com/events');
    expect(result.ok).toBe(true);
  });
});

describe('own lane — policy refusals happen before any network call', () => {
  test('refuses an off-domain URL without fetching', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return htmlResponse('<html><body>nope</body></html>');
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'TestBot/1.0', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://evil.example.net/events');

    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
    expect(called).toBe(false);
  });

  test('refuses an unknown robots policy (fails closed)', async () => {
    const crawler = createCrawler({ userAgent: 'TestBot/1.0', dnsLookup: publicDns });
    const result = await crawler.crawl(
      { ...target, robotsPolicy: 'unknown' },
      'https://venue.example.com/events',
    );
    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
  });

  test('refuses a host that resolves to a private address (DNS rebinding)', async () => {
    const crawler = createCrawler({
      userAgent: 'TestBot/1.0',
      dnsLookup: async () => [{ address: '169.254.169.254', family: 4 }],
    });
    const result = await crawler.crawl(target, 'https://venue.example.com/events');
    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
    if (result.ok) throw new Error('expected refusal');
    expect(result.detail).toMatch(/private IPv4/i);
  });
});

describe('own lane — redirects are re-validated per hop', () => {
  test('refuses to follow a redirect off-domain', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/events')) {
        return new Response(null, { status: 302, headers: { location: 'https://evil.example.net/landing' } });
      }
      return htmlResponse('<html><body>should never be reached</body></html>');
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'TestBot/1.0', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://venue.example.com/events');

    // Refused, and NOT silently downgraded into a successful crawl of the
    // attacker's page.
    expect(result.ok).toBe(false);
  });

  test('follows the apex/www redirect on the same site', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://venue.example.com/events') {
        return new Response(null, { status: 301, headers: { location: 'https://www.venue.example.com/events' } });
      }
      return htmlResponse('<html><body><p>Moved but same site.</p></body></html>', { url });
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'TestBot/1.0', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://venue.example.com/events');

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.text).toContain('Moved but same site.');
  });
});

describe('lane selection', () => {
  test('defaults to the own lane only — never spends without being asked', async () => {
    globalThis.fetch = (async () => htmlResponse('<html><body><p>Free lane content.</p></body></html>')) as typeof fetch;

    const events: UsageEvent[] = [];
    const crawler = createCrawler({
      userAgent: 'TestBot/1.0',
      dnsLookup: publicDns,
      vendor: { firecrawl: 'fc-key-that-should-not-be-used' },
      onUsage: (e) => events.push(e),
    });

    const result = await crawler.crawl(target, 'https://venue.example.com/events');
    expect(result.ok).toBe(true);
    expect(events.every((e) => e.lane === 'own')).toBe(true);
  });

  test('vendor lane requested with no key reports no_lane_available, does not throw', async () => {
    const crawler = createCrawler({ userAgent: 'TestBot/1.0', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://venue.example.com/events', { lanes: ['vendor'] });

    expect(result).toMatchObject({ ok: false, reason: 'no_lane_available' });
    expect(crawler.vendorRungs()).toEqual([]);
  });

  test('a policy refusal does NOT escalate to the paid lane', async () => {
    let vendorCalled = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('firecrawl')) {
        vendorCalled = true;
        return new Response(JSON.stringify({ data: { markdown: 'paid content' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return htmlResponse('<html><body>x</body></html>');
    }) as typeof fetch;

    const crawler = createCrawler({
      userAgent: 'TestBot/1.0',
      dnsLookup: publicDns,
      vendor: { firecrawl: 'fc-test-key-long-enough' },
    });

    // Off-domain is a POLICY refusal — paying a vendor to fetch it anyway
    // would be buying a way around our own guard.
    const result = await crawler.crawl(target, 'https://evil.example.net/x', { lanes: ['own', 'vendor'] });

    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
    expect(vendorCalled).toBe(false);
  });

  test('escalates to the vendor lane when the own lane cannot reach the page', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.firecrawl.dev')) {
        return new Response(JSON.stringify({ data: { markdown: 'Rendered by the vendor.', metadata: { title: 'Vendor Title' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('r.jina.ai')) return new Response('', { status: 500 });
      return new Response('server error', { status: 503 });
    }) as typeof fetch;

    const crawler = createCrawler({
      userAgent: 'TestBot/1.0',
      dnsLookup: publicDns,
      vendor: { firecrawl: 'fc-test-key-long-enough' },
    });

    const result = await crawler.crawl(target, 'https://venue.example.com/events', { lanes: ['own', 'vendor'] });

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.lane).toBe('vendor');
    expect(result.pages[0]!.text).toContain('Rendered by the vendor.');
  });

  test('budget veto blocks the paid call', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('r.jina.ai')) return new Response('', { status: 500 });
      return new Response('server error', { status: 503 });
    }) as typeof fetch;

    const crawler = createCrawler({
      userAgent: 'TestBot/1.0',
      dnsLookup: publicDns,
      vendor: { firecrawl: 'fc-test-key-long-enough' },
      checkBudget: () => false,
    });

    const result = await crawler.crawl(target, 'https://venue.example.com/events', { lanes: ['own', 'vendor'] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.detail).toMatch(/budget/i);
  });
});

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
  test('a huge body is truncated, not buffered whole — crawl still succeeds', async () => {
    // 5 MB body vs the 2 MB cap. Real content up front so the readable
    // prefix still extracts. Filler is realistic prose, NOT one repeated
    // character — a first version used 'x'.repeat(5M) and the prompt-
    // injection guard correctly quarantined it as anomalous content, which
    // was the guard working, not the cap failing.
    const filler = '<p>Every Friday evening the riverside market hosts local vendors and live music for the whole town.</p>';
    const huge =
      '<html><head><title>Big</title></head><body><main><p>Real event content first.</p></main>' +
      filler.repeat(50_000) + '</body></html>';
    globalThis.fetch = (async () =>
      new Response(huge, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://venue.example.com/events');

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.text).toContain('Real event content first.');
    // The page object must not be carrying multi-megabyte text. The
    // sanitiser appends a '\n[TRUNCATED]' marker after its slice (so a
    // consumer can SEE the page was cut), hence cap + marker, not cap exact.
    expect(result.pages[0]!.text.length).toBeLessThanOrEqual(12000 + '\n[TRUNCATED]'.length);
    expect(result.pages[0]!.text.endsWith('[TRUNCATED]')).toBe(true);
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
