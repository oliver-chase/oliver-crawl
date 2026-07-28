import { afterEach, describe, expect, test } from 'vitest';
import { probeCheapChangeSignal } from '@/index';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import type { CrawlTarget } from '@/core/types';

// PROBE-DNS-SEAM-1: the injected resolver was passed for the first host and
// dropped on redirect hops — the hops an attacker controls. A crawler that
// supplies its own resolver had it silently bypassed exactly where it matters.

const target: CrawlTarget = { baseUrl: 'https://site.example.com', robotsPolicy: 'allow', active: true };
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
});

/** First request redirects same-site; the hop is where the resolver must apply. */
function redirectOnce() {
  let first = true;
  globalThis.fetch = (async () => {
    if (first) {
      first = false;
      return new Response('', { status: 301, headers: { location: 'https://www.site.example.com/moved' } });
    }
    return new Response('', { status: 200, headers: { etag: 'W/"abc"' } });
  }) as typeof fetch;
}

describe('the injected resolver applies on redirect hops', () => {
  test('a public-resolving redirect target is followed', async () => {
    redirectOnce();
    const signal = await probeCheapChangeSignal(target, 'https://site.example.com/a', { dnsLookup: publicDns });
    expect(signal?.etag).toBe('W/"abc"');
  });

  test('a redirect target the caller resolves PRIVATE is refused', async () => {
    // The resolver says private only on the second call — the redirect hop.
    let call = 0;
    const rebinding = async (host: string) => {
      call += 1;
      // The redirect host resolves private; the original does not.
      return host.startsWith('www.')
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }];
    };
    redirectOnce();
    const signal = await probeCheapChangeSignal(target, 'https://site.example.com/a', { dnsLookup: rebinding });

    expect(signal).toBeNull();
    expect(call).toBeGreaterThan(1); // the hop really was checked
  });
});
