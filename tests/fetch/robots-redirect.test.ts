import { afterEach, describe, expect, test } from 'vitest';
import { evaluateRobotsForUrl } from '@/fetch/robots-check';

// ROBOTS-REDIRECT-1, found live on an expired domain in a consumer's active list:
// carrabassettvalley.com/robots.txt 301s to sedo.com, a domain-parking sales
// page. The fetcher followed it off-domain and applied sedo.com's answer to
// carrabassettvalley.com. A stranger's robots.txt governing our target is a
// policy bypass: had sedo returned "Allow: /", we would have crawled.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Redirects the FIRST request only; anything after serves the body. Without
 *  that the stub would 301 its own redirect target and loop. */
function redirectTo(location: string, body = 'User-agent: *\nAllow: /') {
  let first = true;
  globalThis.fetch = (async () => {
    if (first) {
      first = false;
      return new Response('', { status: 301, headers: { location } });
    }
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

const check = () =>
  evaluateRobotsForUrl('https://site.example.com/page', {
    userAgent: 'T/1 (+https://t.example.com)',
    dnsLookup: publicDns,
  });

describe('an off-domain robots.txt redirect is followed, and reported', () => {
  // Measured against 60 live sources: refusing these blocked six working
  // sources (a gallery rebrand, .org to .gov, a renamed resort) to stop one
  // parked domain. The 301 is configured by the operator of the OLD domain,
  // so it is their statement rather than a hijack of it.
  test('a domain migration still resolves a policy', async () => {
    redirectTo('https://newname.example.org/robots.txt', 'User-agent: *\nAllow: /');
    const r = await check();
    expect(r.policy).toBe('allow');
  });

  test('the move is surfaced so a consumer can update their registry', async () => {
    redirectTo('https://newname.example.org/robots.txt', 'User-agent: *\nAllow: /');
    const r = await check();
    expect(r.reason).toMatch(/may have moved/i);
    expect(r.reason).toContain('newname.example.org');
  });

  test('a same-domain redirect is not reported as a move', async () => {
    redirectTo('https://www.site.example.com/robots.txt');
    const r = await check();
    expect(r.reason).not.toMatch(/may have moved/i);
  });
});

describe('legitimate same-domain redirects still work', () => {
  test('apex to www is followed', async () => {
    redirectTo('https://www.site.example.com/robots.txt');
    const r = await check();
    expect(r.policy).toBe('allow');
  });

  test('a path redirect on the same host is followed', async () => {
    redirectTo('https://site.example.com/robots.txt?v=2');
    const r = await check();
    expect(r.policy).toBe('allow');
  });
});
