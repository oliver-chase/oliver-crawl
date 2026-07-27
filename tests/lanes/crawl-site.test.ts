import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCrawler } from '@/index';
import { crawlSite } from '@/crawl-site';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import type { CrawlTarget } from '@/core/types';

// The multi-page orchestrator. Everything it does that a single page cannot
// decide for itself: which URLs, how many, retry policy, dedup, and reporting
// per-URL outcomes without one bad page sinking the run.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

const target: CrawlTarget = {
  name: 'Venue',
  baseUrl: 'https://venue.example.com',
  robotsPolicy: 'allow',
  active: true,
};

const page = (body: string) =>
  new Response(`<html><head><title>T</title></head><body><main>${body}</main></body></html>`, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  vi.restoreAllMocks();
});

function crawler() {
  return createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });
}

describe('crawlSite — seeds', () => {
  test('crawls every seed and returns one result for the run', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => page(`Content of ${String(input)}`)) as typeof fetch;

    const result = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/a', 'https://venue.example.com/b'],
    });

    expect(result.pages).toHaveLength(2);
    expect(result.failures).toHaveLength(0);
    expect(result.truncated).toBe(false);
    expect(result.startedAt).toBeTruthy();
    expect(result.finishedAt).toBeTruthy();
  });

  test('falls back to the target baseUrl when no seeds are given', async () => {
    globalThis.fetch = (async () => page('Base page content.')) as typeof fetch;
    const result = await crawlSite(crawler(), target);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.url).toContain('venue.example.com');
  });

  test('an off-site seed is reported as its own failure, others still crawl', async () => {
    globalThis.fetch = (async () => page('Fine.')) as typeof fetch;

    const result = await crawlSite(crawler(), target, {
      seeds: ['https://evil.example.net/x', 'https://venue.example.com/ok'],
    });

    expect(result.pages).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.url).toBe('https://evil.example.net/x');
    expect(result.failures[0]!.reason).toBe('blocked');
  });

  test('an ineligible target fails once, not once per seed', async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return page('x');
    }) as typeof fetch;

    const result = await crawlSite(crawler(), { ...target, robotsPolicy: 'disallow' }, {
      seeds: ['https://venue.example.com/a', 'https://venue.example.com/b', 'https://venue.example.com/c'],
    });

    expect(result.failures).toHaveLength(1);
    expect(result.pages).toHaveLength(0);
    expect(fetched).toBe(false);
  });
});

describe('crawlSite — budget and dedup', () => {
  test('stops at maxPages and reports truncated', async () => {
    globalThis.fetch = (async () => page('Content.')) as typeof fetch;

    const result = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/1', 'https://venue.example.com/2', 'https://venue.example.com/3'],
      maxPages: 2,
    });

    expect(result.pages).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  test('a duplicate seed is fetched once', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return page('Content.');
    }) as typeof fetch;

    const result = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/same', 'https://venue.example.com/same'],
    });

    expect(calls).toBe(1);
    expect(result.pages).toHaveLength(1);
  });

  test('304s count toward the page budget but are not failures', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 304 })) as typeof fetch;

    const result = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/a', 'https://venue.example.com/b'],
      priorValidators: {
        'https://venue.example.com/a': { etag: 'W/"1"' },
        'https://venue.example.com/b': { etag: 'W/"2"' },
      },
    });

    expect(result.notModified).toHaveLength(2);
    expect(result.pages).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
  });
});

describe('crawlSite — retries', () => {
  test('retries a transient failure and succeeds on the second attempt', async () => {
    let attempt = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('r.jina.ai')) return new Response('', { status: 500 });
      attempt++;
      if (attempt === 1) return new Response('boom', { status: 503 });
      return page('Recovered on retry.');
    }) as typeof fetch;

    const result = await crawlSite(crawler(), target, { seeds: ['https://venue.example.com/flaky'], maxRetries: 1 });

    expect(result.pages).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
  });

  // Retrying a policy refusal produces the identical refusal — spending the
  // budget on it is pure waste, so it must not be retried at all.
  test('does NOT retry a terminal (policy) failure', async () => {
    let policyChecks = 0;
    globalThis.fetch = (async () => {
      policyChecks++;
      return page('never reached');
    }) as typeof fetch;

    const result = await crawlSite(crawler(), target, {
      seeds: ['https://elsewhere.example.net/x'],
      maxRetries: 3,
    });

    expect(result.failures).toHaveLength(1);
    expect(policyChecks).toBe(0);
  });

  test('maxRetries: 0 means try once', async () => {
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('r.jina.ai')) return new Response('', { status: 500 });
      calls++;
      return new Response('down', { status: 503 });
    }) as typeof fetch;

    const result = await crawlSite(crawler(), target, { seeds: ['https://venue.example.com/x'], maxRetries: 0 });

    expect(calls).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.reason).toBe('unreachable');
  });

  test('one failing page does not sink the run', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('r.jina.ai')) return new Response('', { status: 500 });
      if (url.includes('/bad')) return new Response('down', { status: 500 });
      return page('Good page.');
    }) as typeof fetch;

    const result = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/good', 'https://venue.example.com/bad'],
      maxRetries: 0,
    });

    expect(result.pages).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
  });
});

describe('crawlSite — pagination', () => {
  test('follows next-page links up to the budget', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/events')) {
        return page('Page one. <a href="/events/page/2">Next</a>');
      }
      if (url.endsWith('/events/page/2')) {
        return page('Page two. <a href="/events/page/3">Next</a>');
      }
      return page('Page three, last.');
    }) as typeof fetch;

    const result = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/events'],
      followPagination: true,
      maxPages: 3,
    });

    expect(result.pages).toHaveLength(3);
    expect(result.pages.map((p) => p.url)).toEqual([
      'https://venue.example.com/events',
      'https://venue.example.com/events/page/2',
      'https://venue.example.com/events/page/3',
    ]);
  });

  test('pagination is off by default', async () => {
    globalThis.fetch = (async () => page('Only page. <a href="/events/page/2">Next</a>')) as typeof fetch;

    const result = await crawlSite(crawler(), target, { seeds: ['https://venue.example.com/events'] });
    expect(result.pages).toHaveLength(1);
  });

  test('a next-page link that loops back is not re-crawled', async () => {
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls++;
      const url = String(input);
      if (url.endsWith('/events')) return page('One. <a href="/events/page/2">Next</a>');
      // page 2 points back at page 1 — a real pattern, and an infinite loop
      // if the orchestrator did not dedup.
      return page('Two. <a href="/events">Next</a>');
    }) as typeof fetch;

    const result = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/events'],
      followPagination: true,
      maxPages: 10,
    });

    expect(calls).toBe(2);
    expect(result.pages).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  test('an off-site next link is ignored, not an error', async () => {
    globalThis.fetch = (async () => page('One. <a href="https://other.example.net/page/2">Next</a>')) as typeof fetch;

    const result = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/events'],
      followPagination: true,
    });

    expect(result.pages).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
  });
});

describe('crawlSite — validator round-trip (re-crawl efficiency)', () => {
  test('returns fresh validators for every crawled page and fires onSignals', async () => {
    globalThis.fetch = (async () =>
      new Response('<html><head><title>T</title></head><body><main>Fresh content.</main></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html', etag: 'W/"v2"', 'last-modified': 'Thu, 02 Jan 2025 00:00:00 GMT' },
      })) as typeof fetch;

    let signalled: { id: string; validators: Record<string, unknown> } | null = null;
    const result = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/events'],
      targetId: 'source-42',
      onSignals: (id, validators) => {
        signalled = { id, validators };
      },
    });

    const v = result.validators['https://venue.example.com/events'];
    expect(v).toMatchObject({ etag: 'W/"v2"', lastModified: 'Thu, 02 Jan 2025 00:00:00 GMT' });
    expect(v!.bodySha256).toMatch(/^[0-9a-f-]{16,}$/);
    expect(signalled).not.toBeNull();
    expect(signalled!.id).toBe('source-42');
    expect(signalled!.validators['https://venue.example.com/events']).toBeTruthy();
  });

  test('a 304 carries the prior validators forward instead of dropping them', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 304 })) as typeof fetch;

    const result = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/events'],
      priorValidators: { 'https://venue.example.com/events': { etag: 'W/"v1"' } },
    });

    // Without this, one unchanged crawl would wipe the stored validator and
    // the NEXT run would pay a full fetch again — the opposite of the point.
    expect(result.validators['https://venue.example.com/events']).toMatchObject({ etag: 'W/"v1"' });
    expect(result.notModified).toEqual(['https://venue.example.com/events']);
  });

  test('a throwing onSignals sink does not break the crawl', async () => {
    globalThis.fetch = (async () =>
      new Response('<html><body><main>Content.</main></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as typeof fetch;

    const result = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/events'],
      onSignals: () => {
        throw new Error('sink exploded');
      },
    });
    expect(result.pages).toHaveLength(1);
  });
});
