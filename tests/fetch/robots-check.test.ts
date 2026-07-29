import { describe, expect, test, vi } from 'vitest';

// The fetch-layer tests exercise robots parsing, not the SSRF/DNS guard —
// stub the public-host check so they don't make a real DNS lookup.
vi.mock('@/fetch/host-policy', () => ({
  assertHostResolvesToPublicAddress: vi.fn().mockResolvedValue(undefined),
}));

import { parseRobots, evaluateRobotsForUrl, userAgentToken } from '@/fetch/robots-check';

const UA = 'examplebot';

describe('parseRobots', () => {
  test('empty robots.txt = allow', () => {
    expect(parseRobots('', UA, '/events').policy).toBe('allow');
  });

  test('User-agent: * Allow: / = allow (the Ommegang case)', () => {
    const txt = 'User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /';
    expect(parseRobots(txt, UA, '/events-concerts/').policy).toBe('allow');
  });

  test('named AI-bot disallow does not affect the configured bot', () => {
    const txt = 'User-agent: ClaudeBot\nDisallow: /\nUser-agent: GPTBot\nDisallow: /\nUser-agent: *\nAllow: /';
    expect(parseRobots(txt, UA, '/whatever').policy).toBe('allow');
  });

  test('global Disallow: / = disallow', () => {
    expect(parseRobots('User-agent: *\nDisallow: /', UA, '/events').policy).toBe('disallow');
  });

  test('empty Disallow means allow everything', () => {
    expect(parseRobots('User-agent: *\nDisallow:', UA, '/events').policy).toBe('allow');
  });

  test('path-specific disallow blocks only that path', () => {
    const txt = 'User-agent: *\nDisallow: /admin';
    expect(parseRobots(txt, UA, '/admin/secret').policy).toBe('disallow');
    expect(parseRobots(txt, UA, '/events').policy).toBe('allow');
  });

  test('Allow overrides a longer... shorter Disallow via longest-match', () => {
    const txt = 'User-agent: *\nDisallow: /events\nAllow: /events/public';
    expect(parseRobots(txt, UA, '/events/public/x').policy).toBe('allow');
    expect(parseRobots(txt, UA, '/events/private').policy).toBe('disallow');
  });

  test('an agent-specific group wins over *', () => {
    const txt = 'User-agent: *\nDisallow: /\nUser-agent: ExampleBot\nAllow: /';
    expect(parseRobots(txt, UA, '/events').policy).toBe('allow');
  });

  test('$ end-anchor honored', () => {
    const txt = 'User-agent: *\nDisallow: /*.pdf$';
    expect(parseRobots(txt, UA, '/a/b.pdf').policy).toBe('disallow');
    expect(parseRobots(txt, UA, '/a/b.pdf?x=1').policy).toBe('allow');
  });

  test('comments and non-standard directives ignored', () => {
    const txt = '# hello\nContent-Signal: search=yes\nSitemap: https://x/sitemap.xml\nUser-agent: *\nAllow: / # inline';
    expect(parseRobots(txt, UA, '/events').policy).toBe('allow');
  });
});

describe('evaluateRobotsForUrl (fetch layer)', () => {
  test('404 robots.txt = allow', async () => {
    const fetchImpl = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    const r = await evaluateRobotsForUrl('https://example.com/events', { fetchImpl });
    expect(r.policy).toBe('allow');
  });

  // ROBOTS-4XX-1: this asserted 403 = unknown. RFC 9309 says a 4xx means the
  // file is UNAVAILABLE and the crawler may access — a 403 and a 404 are
  // equivalent. The old expectation was stricter than the standard and
  // refused four of sixty live sources that read fine once permitted.
  test('4xx = unavailable, which permits (RFC 9309)', async () => {
    const fetchImpl = (async () => new Response('blocked', { status: 403 })) as unknown as typeof fetch;
    const r = await evaluateRobotsForUrl('https://example.com/events', { fetchImpl });
    expect(r.policy).toBe('allow');
  });

  test('5xx = unknown (fails closed)', async () => {
    const fetchImpl = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    const r = await evaluateRobotsForUrl('https://example.com/events', { fetchImpl });
    expect(r.policy).toBe('unknown');
  });

  test('fetch throw = unknown (fails closed)', async () => {
    const fetchImpl = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    const r = await evaluateRobotsForUrl('https://example.com/events', { fetchImpl });
    expect(r.policy).toBe('unknown');
  });

  test('200 with Allow: / = allow', async () => {
    const fetchImpl = (async () => new Response('User-agent: *\nAllow: /', { status: 200 })) as unknown as typeof fetch;
    const r = await evaluateRobotsForUrl('https://example.com/events', { fetchImpl });
    expect(r.policy).toBe('allow');
  });

  test('follows a 301 redirect and reads the real robots.txt (the Beak & Skiff case)', async () => {
    let call = 0;
    const fetchImpl = (async (url: string | URL) => {
      call += 1;
      const u = url.toString();
      if (u === 'https://example.com/robots.txt') {
        return new Response('', { status: 301, headers: { location: 'https://www.example.com/robots.txt' } });
      }
      return new Response('User-agent: *\nAllow: /', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await evaluateRobotsForUrl('https://example.com/events', { fetchImpl });
    expect(call).toBe(2);
    expect(r.policy).toBe('allow');
  });

  test('a redirect loop past the hop cap = unknown', async () => {
    const fetchImpl = (async () =>
      new Response('', { status: 302, headers: { location: 'https://example.com/robots.txt?x' } })) as unknown as typeof fetch;
    const r = await evaluateRobotsForUrl('https://example.com/events', { fetchImpl });
    expect(r.policy).toBe('unknown');
  });

  test('invalid / non-http URL = unknown', async () => {
    expect((await evaluateRobotsForUrl('ftp://example.com')).policy).toBe('unknown');
    expect((await evaluateRobotsForUrl('not a url')).policy).toBe('unknown');
  });
});

// The crawler's robots identity is derived from its configured User-Agent
// rather than hardcoded, so a consumer's robots group actually matches the UA
// it sends. Untested when first ported — added with the change.
describe('userAgentToken', () => {
  test('takes the product token before the version', () => {
    expect(userAgentToken('MyBot/1.0 (+https://example.com/bot)')).toBe('mybot');
    expect(userAgentToken('OliverCrawl/0.1 (+https://github.com/x)')).toBe('olivercrawl');
  });

  test('lowercases, so robots group matching is case-insensitive', () => {
    expect(userAgentToken('ExampleBot/2.0')).toBe('examplebot');
  });

  test('handles a bare name with no version', () => {
    expect(userAgentToken('SimpleBot')).toBe('simplebot');
  });

  // The derived token must actually match a robots group naming that bot —
  // this is the end-to-end property the derivation exists for.
  test('the derived token matches its own robots group', () => {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: MyBot\nDisallow:';
    expect(parseRobots(txt, userAgentToken('MyBot/1.0'), '/events').policy).toBe('allow');
    expect(parseRobots(txt, userAgentToken('OtherBot/1.0'), '/events').policy).toBe('disallow');
  });
});
