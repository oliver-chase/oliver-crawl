import { afterEach, describe, expect, test } from 'vitest';
import { isSafeHttpUrl, assertPublicHost, fetchViaWayback, probeCheapChangeSignal } from '@/index';

// These are exported for consumers and were reachable only indirectly through
// other suites. An exported helper with no direct test is one refactor away
// from silently changing behaviour for every consumer that calls it.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('isSafeHttpUrl — what may survive extraction', () => {
  test.each([
    'https://example.com/page',
    'http://example.com/page',
    'https://example.com:8443/page',
  ])('accepts %s', (url) => {
    expect(isSafeHttpUrl(url)).toBe(true);
  });

  test.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://example.com/x',
    'not a url',
    '',
  ])('refuses %j', (url) => {
    // A javascript: href reaching a caller's UI is an XSS; a file: URL
    // reaching a fetcher is local disclosure.
    expect(isSafeHttpUrl(url)).toBe(false);
  });

  test('refuses private and loopback hosts', () => {
    expect(isSafeHttpUrl('http://127.0.0.1/')).toBe(false);
    expect(isSafeHttpUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isSafeHttpUrl('http://localhost/')).toBe(false);
  });
});

describe('assertPublicHost — the SSRF gate, called directly', () => {
  test('a public hostname passes', () => {
    expect(() => assertPublicHost('example.com')).not.toThrow();
  });

  test.each(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'thing.internal', 'box.local'])(
    'refuses %s',
    (host) => {
      expect(() => assertPublicHost(host)).toThrow();
    },
  );
});

describe('fetchViaWayback — called directly rather than through the ladder', () => {
  test('returns the archived body for a capture that exists', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/cdx/search/cdx')) {
        return new Response(JSON.stringify([['timestamp', 'original'], ['20260601120000', 'https://x.com/a']]), { status: 200 });
      }
      return new Response('<html><body>archived</body></html>', { status: 200 });
    }) as typeof fetch;

    const r = await fetchViaWayback('https://x.com/a');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected a capture');
    expect(r.html).toContain('archived');
    expect(r.capturedAt).toBe('2026-06-01T12:00:00Z');
  });

  test('no capture is an answer, not a throw', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([['timestamp', 'original']]), { status: 200 })) as typeof fetch;
    const r = await fetchViaWayback('https://x.com/a');
    expect(r.ok).toBe(false);
  });

  test('a non-http URL is refused before any request', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('', { status: 200 });
    }) as typeof fetch;

    const r = await fetchViaWayback('file:///etc/passwd');
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  test('an archive outage is an answer, not a throw', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ENOTFOUND');
    }) as typeof fetch;
    const r = await fetchViaWayback('https://x.com/a');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.detail).toMatch(/failed/i);
  });
});

describe('probeCheapChangeSignal — the pre-fetch change probe', () => {
  // PROBE-DNS-SEAM-1 is closed: dnsLookup is injectable, so the success path
  // is exercisable without real DNS like every other fetch path here.
  test('reports the validators the origin exposes', async () => {
    globalThis.fetch = (async () =>
      new Response('', {
        status: 200,
        headers: { etag: 'W/"abc"', 'last-modified': 'Wed, 01 Jul 2026 00:00:00 GMT' },
      })) as typeof fetch;

    const target = { baseUrl: 'https://x.example.com', robotsPolicy: 'allow' as const, active: true };
    const signal = await probeCheapChangeSignal(target, 'https://x.example.com/a', {
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    expect(signal?.etag).toBe('W/"abc"');
  });

  test('an off-domain URL is refused without a request', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('', { status: 200 });
    }) as typeof fetch;

    const target = { baseUrl: 'https://x.com', robotsPolicy: 'allow' as const, active: true };
    await expect(probeCheapChangeSignal(target, 'https://other.example.net/a')).resolves.toBeNull();
    expect(called).toBe(false);
  });

  test('an unreachable host yields null rather than throwing', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch;

    const target = { baseUrl: 'https://x.com', robotsPolicy: 'allow' as const, active: true };
    await expect(probeCheapChangeSignal(target, 'https://x.com/a')).resolves.toBeNull();
  });
});
