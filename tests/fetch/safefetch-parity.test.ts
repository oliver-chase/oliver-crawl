import { afterEach, describe, expect, test } from 'vitest';
import { safeFetch } from '@/index';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';

// SAFEFETCH-PARITY-1: this claimed "same discipline as robots-check /
// cheap-change-probe" and was weaker than both — it accepted ANY redirect host,
// and took no injectable resolver, so a crawler running its own DNS had it
// bypassed here entirely.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearDnsCacheForTests();
});

function redirectTo(location: string) {
  let first = true;
  return (async () => {
    if (first) {
      first = false;
      return new Response('', { status: 301, headers: { location } });
    }
    return new Response('BEGIN:VCALENDAR', { status: 200 });
  }) as typeof fetch;
}

describe('a redirect may not leave the target site', () => {
  test('an off-site redirect is refused', async () => {
    const res = await safeFetch('https://site.example.com/feed', redirectTo('https://attacker.example.net/x'), 'text/calendar', {
      sameSiteAs: 'https://site.example.com',
      dnsLookup: publicDns,
    });
    expect(res).toBeNull();
  });

  test('a same-site redirect is followed', async () => {
    const res = await safeFetch('https://site.example.com/feed', redirectTo('https://www.site.example.com/x'), 'text/calendar', {
      sameSiteAs: 'https://site.example.com',
      dnsLookup: publicDns,
    });
    expect(res?.ok).toBe(true);
  });

  test('without sameSiteAs the old permissive behaviour is unchanged', async () => {
    // The option is opt-in so existing callers are not broken silently.
    const res = await safeFetch('https://site.example.com/feed', redirectTo('https://other.example.net/x'), 'text/calendar', {
      dnsLookup: publicDns,
    });
    expect(res?.ok).toBe(true);
  });
});

describe('the caller’s resolver is honoured', () => {
  test('a private-resolving host is refused via the injected resolver', async () => {
    const privateDns = async () => [{ address: '127.0.0.1', family: 4 }];
    const res = await safeFetch('https://site.example.com/feed', redirectTo('https://site.example.com/x'), 'text/calendar', {
      dnsLookup: privateDns,
    });
    expect(res).toBeNull();
  });
});
