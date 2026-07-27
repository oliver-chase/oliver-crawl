import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCrawler } from '@/index';
import { renderServiceFrom, renderViaService } from '@/fetch/browser-render';
import { resolveConfig } from '@/core/config';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import type { CrawlTarget, UsageEvent } from '@/core/types';

// The browser-render rung. It lives in the OWN lane because the endpoint is
// infrastructure the consumer controls, not a vendor API — so it must behave
// like every other own-lane rung: optional, degrading to "skipped" rather
// than failing, and never able to end a crawl on its own.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

const target: CrawlTarget = {
  name: 'JS Venue',
  baseUrl: 'https://venue.example.com',
  robotsPolicy: 'allow',
  active: true,
};

/** A page that renders to nothing without JavaScript — the exact case this
 *  rung exists for. */
const JS_SHELL = '<html><head><title>App</title></head><body><div id="root"></div></body></html>';

/** Jina rejects anything under 200 chars as "not a real page" (a guard against
 *  routing a source to a dead fallback), so a realistic stub has to clear it. */
const JINA_BODY = (marker: string) =>
  `Title: Recovered\nURL Source: https://venue.example.com/events\n\nMarkdown Content:\n${marker} ` +
  'Summer Concert Series runs every Friday at Riverside Park, doors at six, free admission. '.repeat(4);

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  vi.restoreAllMocks();
});

describe('renderServiceFrom — configuration', () => {
  test('returns null when unconfigured (rung simply does not exist)', () => {
    expect(renderServiceFrom(resolveConfig({ userAgent: 'T/1' }))).toBeNull();
  });

  test('refuses a plaintext endpoint', () => {
    // Rendered HTML feeds extraction directly — a plaintext hop would let
    // anyone on the path rewrite what the crawler believes the page said.
    const config = resolveConfig({ userAgent: 'T/1', browserRender: { url: 'http://render.internal' } });
    expect(renderServiceFrom(config)).toBeNull();
  });

  test('refuses a malformed endpoint rather than throwing', () => {
    const config = resolveConfig({ userAgent: 'T/1', browserRender: { url: 'not a url' } });
    expect(renderServiceFrom(config)).toBeNull();
  });

  test('accepts https and strips trailing slashes', () => {
    const config = resolveConfig({ userAgent: 'T/1', browserRender: { url: 'https://render.example.com//', token: 'tok' } });
    expect(renderServiceFrom(config)).toEqual({ url: 'https://render.example.com', token: 'tok' });
  });
});

describe('renderViaService', () => {
  test('sends the configured UA and bearer token', async () => {
    let seenHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ html: '<html><body><p>Rendered.</p></body></html>' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const config = resolveConfig({ userAgent: 'MyBot/2.0', browserRender: { url: 'https://render.example.com', token: 'secret-token' } });
    const result = await renderViaService('https://venue.example.com/events', config);

    expect(result?.html).toContain('Rendered.');
    expect(seenHeaders['user-agent']).toBe('MyBot/2.0');
    expect(seenHeaders.authorization).toBe('Bearer secret-token');
  });

  test('omits the auth header when no token is set', async () => {
    let seenHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ html: '<html><body><p>ok</p></body></html>' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const config = resolveConfig({ userAgent: 'T/1', browserRender: { url: 'https://render.example.com' } });
    await renderViaService('https://venue.example.com/events', config);
    expect(seenHeaders.authorization).toBeUndefined();
  });

  test('returns null (not an error) when unconfigured', async () => {
    const config = resolveConfig({ userAgent: 'T/1' });
    expect(await renderViaService('https://venue.example.com/events', config)).toBeNull();
  });

  // Configured-but-broken is DIFFERENT from unconfigured, and must be
  // reported rather than silently degraded — otherwise a dead render service
  // looks identical to one that was never set up.
  test('throws on a service error, so a broken service is visible', async () => {
    globalThis.fetch = (async () => new Response('upstream exploded', { status: 502 })) as typeof fetch;
    const config = resolveConfig({ userAgent: 'T/1', browserRender: { url: 'https://render.example.com' } });
    await expect(renderViaService('https://venue.example.com/x', config)).rejects.toThrow(/502/);
  });

  test('throws when the service reports its own error payload', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'navigation timeout' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const config = resolveConfig({ userAgent: 'T/1', browserRender: { url: 'https://render.example.com' } });
    await expect(renderViaService('https://venue.example.com/x', config)).rejects.toThrow(/navigation timeout/);
  });
});

describe('own lane — render rung integration', () => {
  test('a JS shell is rescued by the render rung', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('render.example.com')) {
        return new Response(
          JSON.stringify({ html: '<html><body><main><p>Three real events, after JS.</p></main></body></html>' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JS_SHELL, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;

    const crawler = createCrawler({
      userAgent: 'T/1',
      dnsLookup: publicDns,
      browserRender: { url: 'https://render.example.com' },
    });
    const result = await crawler.crawl(target, 'https://venue.example.com/events');

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.rung).toBe('browser-render');
    expect(result.pages[0]!.lane).toBe('own'); // our infrastructure, not a vendor
    expect(result.pages[0]!.text).toContain('Three real events, after JS.');
  });

  test('a broken render service falls through to Jina rather than ending the crawl', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('render.example.com')) return new Response('down', { status: 500 });
      if (url.includes('r.jina.ai')) {
        return new Response(JINA_BODY('Recovered by the free rung.'), { status: 200 });
      }
      return new Response(JS_SHELL, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;

    const events: UsageEvent[] = [];
    const crawler = createCrawler({
      userAgent: 'T/1',
      dnsLookup: publicDns,
      browserRender: { url: 'https://render.example.com' },
      onUsage: (e) => events.push(e),
    });
    const result = await crawler.crawl(target, 'https://venue.example.com/events');

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.rung).toBe('jina');
    // The render failure is still REPORTED, not swallowed silently.
    expect(events.some((e) => e.rung === 'browser-render' && !e.ok)).toBe(true);
  });

  test('with no render service configured the rung is skipped entirely', async () => {
    let renderCalled = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('render')) renderCalled = true;
      if (url.includes('r.jina.ai')) {
        return new Response(JINA_BODY('Straight to the free rung.'), { status: 200 });
      }
      return new Response(JS_SHELL, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;

    const crawler = createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });
    const result = await crawler.crawl(target, 'https://venue.example.com/events');

    expect(renderCalled).toBe(false);
    expect(result.ok).toBe(true);
  });
});

describe('local render rung (free) — guards', () => {
  test('not opted in -> null, rung skipped', async () => {
    const { renderViaLocalChromium } = await import('@/fetch/local-render');
    expect(await renderViaLocalChromium('https://venue.example.com/x', false)).toBeNull();
  });

  test('opted in but playwright absent -> null, degrades silently to the next rung', async () => {
    // playwright is deliberately NOT a dependency of this package; in this
    // test env the Function-constructor import fails and the rung must
    // degrade to null, never throw.
    const { renderViaLocalChromium } = await import('@/fetch/local-render');
    expect(await renderViaLocalChromium('https://venue.example.com/x', true)).toBeNull();
  });

  test('empty URL -> null', async () => {
    const { renderViaLocalChromium } = await import('@/fetch/local-render');
    expect(await renderViaLocalChromium('', true)).toBeNull();
  });
});
