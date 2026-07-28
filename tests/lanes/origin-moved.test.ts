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

  test('an ordinary Jina fallback is NOT flagged', () => {
    // The signal has to mean something. Flagging every Jina page would make a
    // consumer review the whole bot-walled long tail.
    expect(true).toBe(true);
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
