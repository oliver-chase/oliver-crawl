import { afterEach, describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { __clearPageCacheForTests } from '@/core/page-cache';
import { __clearThrottleForTests } from '@/core/host-throttle';
import { __clearRobotsCacheForTests } from '@/lanes/own/index';
import { assertRedirectUrlAllowedForHost } from '@/fetch/host-policy';
import type { CrawlTarget } from '@/core/types';

// ORIGIN-MOVED-1: a page served past a policy refusal is not an ordinary success.
//
// Found on a live source. isisasheville.com was sold and redirects to a Spanish
// medical centre; the direct rung correctly refuses the off-domain redirect,
// Jina then follows the same redirect from its own IPs, and the crawl returned
// the new owner's content under the old URL with `ok: true` and nothing to
// distinguish it. A consumer would have published events for a venue that no
// longer exists.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const target: CrawlTarget = { baseUrl: 'https://site.example.com', robotsPolicy: 'allow', active: true };
const JINA_BODY = 'Title: Someone Else\nURL Source: https://site.example.com/\n\nMarkdown Content:\nA completely different business, with plenty of text to clear the thresholds. '.repeat(3);

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
  __clearPageCacheForTests();
  __clearThrottleForTests();
  __clearRobotsCacheForTests();
});

describe('a page served past an off-domain refusal is flagged', () => {
  test('the refusal travels with the result', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('r.jina.ai')) return new Response(JINA_BODY, { status: 200 });
      // The origin was sold: it now bounces to a different host.
      return new Response(null, { status: 301, headers: { location: 'https://newowner.example.net/' } });
    }) as typeof fetch;

    const result = await createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns }).crawl(
      target,
      'https://site.example.com/',
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.rung).toBe('jina');
    expect(result.originMoved, 'a sold domain returned as an ordinary success').toBeDefined();
    expect(result.originMoved!.refusal).toMatch(/off-domain/);
    expect(result.originMoved!.servedBy).toBe('jina');
  });

  test('an ordinary Jina fallback is NOT flagged', async () => {
    // The signal has to mean something. Flagging every Jina page would make a
    // consumer review the whole bot-walled long tail. This was `expect(true)`
    // — a name asserting a guarantee its body never checked.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('r.jina.ai')) return new Response(JINA_BODY, { status: 200 });
      return new Response('blocked', { status: 403 });
    }) as typeof fetch;

    const result = await createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns }).crawl(
      target,
      'https://site.example.com/',
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.rung).toBe('jina');
    expect(result.originMoved, 'a plain bot-wall was reported as a moved origin').toBeUndefined();
  });

  test('the RENDER rung is flagged too — it runs before Jina', async () => {
    // QA found the first version wrapped the Jina branch only, and
    // renderFallback runs BEFORE it. On any deployment with browserRender
    // configured the flag was unreachable, which is most of them.
    const RENDERED = `<html><head><title>New Owner</title></head><body><main><p>${'Different business copy here. '.repeat(12)}</p></main></body></html>`;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('render.example.com')) {
        return new Response(JSON.stringify({ html: RENDERED }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 301, headers: { location: 'https://newowner.example.net/' } });
    }) as typeof fetch;

    const result = await createCrawler({
      userAgent: 'T/1 (+https://t.example.com)',
      dnsLookup: publicDns,
      browserRender: { url: 'https://render.example.com' },
    }).crawl(target, 'https://site.example.com/');

    expect(result.ok).toBe(true);
    if (!result.ok || result.notModified) throw new Error('expected pages');
    expect(result.pages[0]!.rung).toBe('browser-render');
    expect(result.originMoved, 'the render rung served a moved origin unflagged').toBeDefined();
    expect(result.originMoved!.servedBy).toBe('browser-render');
  });

  test('the render SERVICE cannot land us off-site (RENDER-REDIRECT-2)', async () => {
    // The service reports where it landed and that value was trusted all the
    // way into buildPage. The local rung had this check; the remote one had
    // none anywhere.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('render.example.com')) {
        return new Response(
          JSON.stringify({ html: '<html><body><main><p>Someone else entirely.</p></main></body></html>', url: 'https://elsewhere.example.net/' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('blocked', { status: 403 });
    }) as typeof fetch;

    const result = await createCrawler({
      userAgent: 'T/1 (+https://t.example.com)',
      dnsLookup: publicDns,
      browserRender: { url: 'https://render.example.com' },
    }).crawl(target, 'https://site.example.com/');

    // It must not come back as a successful render of the requested page.
    if (result.ok && !result.notModified) {
      expect(result.pages[0]!.rung).not.toBe('browser-render');
    }
  });

  // QA enumerated every message the redirect guard can produce and drove each
  // one. The first detector matched the words "off-domain", and the guard
  // checks https and credentials BEFORE off-domain — so a parked domain that
  // 301s to plain http was refused as "non-https" and never flagged. The
  // decision now reads the URL in the refusal instead of its wording.
  test.each([
    ['off-domain over https', 'https://newowner.example.net/', true],
    ['off-domain over http', 'http://newowner.example.net/', true],
    ['off-domain carrying credentials', 'https://u:p@newowner.example.net/', true],
    // Same publisher on a subdomain is a routine platform migration, not a
    // move. Flagging it adds review load for a non-event.
    ['a subdomain of the same site', 'https://events.site.example.com/', false],
    ['a different port on the same host', 'https://site.example.com:8443/', false],
  ])('%s -> flagged=%s', async (_name, location, expected) => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('r.jina.ai')) return new Response(JINA_BODY, { status: 200 });
      return new Response(null, { status: 301, headers: { location: location as string } });
    }) as typeof fetch;

    const result = await createCrawler({ userAgent: 'T/1 (+https://t.example.com)', dnsLookup: publicDns }).crawl(
      target,
      'https://site.example.com/',
    );
    const flagged = Boolean(result.ok && !result.notModified && result.originMoved);
    expect(flagged).toBe(expected);
  });

  test('the detector recognises the real guard message', () => {
    // Matched on the guard's own wording, so the coupling is pinned here: a
    // reworded guard fails this rather than silently turning the signal off.
    let message = '';
    try {
      assertRedirectUrlAllowedForHost('site.example.com', '', 'https://other.example.com/x');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/Blocked off-domain (redirect|crawl) URL/);
  });
});
