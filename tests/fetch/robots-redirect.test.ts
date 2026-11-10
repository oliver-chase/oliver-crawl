import { describe, expect, test } from 'vitest';
import { evaluateRobotsForUrl } from '@/fetch/robots-check';
import { publicDns } from '../helpers';

// ROBOTS-REDIRECT-1: when a target's robots.txt 301s to a different domain (for
// example a domain-parking page), the other domain's answer must not govern the
// target. An off-domain robots.txt that said "Allow: /" would otherwise be a
// policy bypass.

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
  // Refusing every off-domain robots redirect would block legitimate
  // migrations (a rebrand, .org to .gov, a renamed site). The 301 is configured
  // by the operator of the OLD domain, so it is their own statement.
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
