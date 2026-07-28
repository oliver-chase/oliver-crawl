import { afterEach, describe, expect, test } from 'vitest';
import { evaluateRobotsForUrl } from '@/fetch/robots-check';

// ROBOTS-4XX-1: RFC 9309 §2.3.1.3 — a 4xx on robots.txt means the file is
// UNAVAILABLE, and "the crawler MAY access any resources". A 403 and a 404 are
// equivalent. 5xx is the opposite: assume complete disallow.
//
// We allowed 404/410 and treated every other 4xx as unknown, which fails
// closed. Measured cost: 4 of 60 live sources refused outright, all of which
// read fine once permitted — the robots fetch was the only thing failing.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function robotsStatus(status: number, body = '') {
  globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
}

const check = () =>
  evaluateRobotsForUrl('https://site.example.com/page', {
    userAgent: 'T/1 (+https://t.example.com)',
    dnsLookup: publicDns,
  });

describe('4xx means unavailable, which permits crawling (RFC 9309)', () => {
  test.each([400, 401, 403, 404, 410, 451])('%i permits', async (status) => {
    robotsStatus(status);
    const r = await check();
    expect(r.policy).toBe('allow');
  });

  test('429 is the exception — rate limited, not unavailable', async () => {
    // Treating a rate limit as permission is how a crawler turns a temporary
    // block into a ban.
    robotsStatus(429);
    const r = await check();
    expect(r.policy).toBe('unknown');
  });
});

describe('5xx and transport failures still fail closed', () => {
  test.each([500, 502, 503])('%i does NOT permit', async (status) => {
    robotsStatus(status);
    const r = await check();
    expect(r.policy).toBe('unknown');
  });

  test('a network failure does not permit', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch;
    const r = await check();
    expect(r.policy).toBe('unknown');
  });
});

describe('a served robots.txt is still obeyed', () => {
  test('a 200 Disallow still refuses', async () => {
    robotsStatus(200, 'User-agent: *\nDisallow: /');
    const r = await check();
    expect(r.policy).toBe('disallow');
  });
});
