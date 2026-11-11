import { describe, expect, test, vi } from 'vitest';
import { discoverSitemapUrls } from '@/fetch/sitemap-discovery';
import { fetchViaJina } from '@/fetch/jina-fetch';
import { safeFetch } from '@/fetch/safe-fetch';
import type { CrawlTarget } from '@/core/types';
import { publicDns } from '../helpers';

// Every network read stops at its cap, redirects stay on the target's site, and the caller's
// user agent and resolver reach the wire.

const target: CrawlTarget = { name: 'Site', baseUrl: 'https://site.example.com', robotsPolicy: 'allow', active: true };

/** A body that never ends, counting the bytes the reader pulled. */
function endlessBody(counter: { bytes: number }): Response {
  const chunk = new Uint8Array(64 * 1024).fill(97);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      counter.bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
}

describe('the byte cap counts bytes', () => {
  test('multi-byte text stops at the cap in bytes, not characters', async () => {
    let chunksPulled = 0;
    const chunk = new TextEncoder().encode('€'.repeat(100)); // 300 bytes, 100 characters
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled++;
        controller.enqueue(chunk);
      },
    });
    const { readBodyCapped } = await import('@/fetch/http-mechanics');
    await readBodyCapped(new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8' } }), 3000);
    // 3000 bytes is 10 chunks. A counter that counted characters would pull about 30.
    expect(chunksPulled * 300).toBeLessThanOrEqual(3000 + 3 * 300);
  });
});

describe('bounded reads', () => {
  test('a sitemap that never ends is cut near the cap', async () => {
    const counter = { bytes: 0 };
    globalThis.fetch = (async () => endlessBody(counter)) as typeof fetch;
    await discoverSitemapUrls(target, { userAgent: 'T/1', dnsLookup: publicDns });
    expect(counter.bytes).toBeLessThan(4_000_000);
  });

  test('a Jina response that never ends is cut near the cap', async () => {
    const counter = { bytes: 0 };
    await fetchViaJina('https://site.example.com/', { fetchImpl: (async () => endlessBody(counter)) as typeof fetch });
    expect(counter.bytes).toBeLessThan(1_000_000);
  });
});

describe('sitemap redirects', () => {
  /** Answers 301 to `to`, and fetches `to` itself when the caller let the runtime follow redirects. */
  function redirectingFetch(to: string, seen: string[]): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      if (init?.redirect === 'manual') return new Response(null, { status: 301, headers: { location: to } });
      seen.push(to);
      return new Response('<urlset></urlset>', { status: 200 });
    }) as typeof fetch;
  }

  test('a redirect to a private address is refused and never requested', async () => {
    const seen: string[] = [];
    globalThis.fetch = redirectingFetch('http://169.254.169.254/latest/meta-data/', seen);
    await discoverSitemapUrls(target, { userAgent: 'T/1', dnsLookup: publicDns });
    expect(seen.some((url) => url.includes('169.254.169.254'))).toBe(false);
  });

  test('a redirect to another site is refused', async () => {
    const seen: string[] = [];
    globalThis.fetch = redirectingFetch('https://other.example.net/sitemap.xml', seen);
    await discoverSitemapUrls(target, { userAgent: 'T/1', dnsLookup: publicDns });
    expect(seen.some((url) => url.includes('other.example.net'))).toBe(false);
  });
});

describe('request shape', () => {
  test('safeFetch sends the caller user agent', async () => {
    let sent = '';
    const doFetch = (async (_url: string, init?: RequestInit) => {
      sent = String((init?.headers as Record<string, string>)['User-Agent']);
      return new Response('ok');
    }) as unknown as typeof fetch;
    await safeFetch('https://site.example.com/feed', doFetch, 'text/plain', { dnsLookup: publicDns, userAgent: 'MyBot/2 (+https://example.com/bot)' });
    expect(sent).toBe('MyBot/2 (+https://example.com/bot)');
  });

  test('Jina refuses a private or http target before any request', async () => {
    const doFetch = vi.fn();
    expect(await fetchViaJina('http://site.example.com/', { fetchImpl: doFetch as unknown as typeof fetch })).toBeNull();
    expect(await fetchViaJina('https://localhost/', { fetchImpl: doFetch as unknown as typeof fetch })).toBeNull();
    expect(await fetchViaJina('https://10.0.0.5/', { fetchImpl: doFetch as unknown as typeof fetch })).toBeNull();
    expect(doFetch).not.toHaveBeenCalled();
  });
});
