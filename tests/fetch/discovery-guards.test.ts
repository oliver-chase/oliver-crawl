import { describe, expect, test, vi } from 'vitest';
import { safeFetch } from '@/fetch/safe-fetch';
import { fetchViaJina } from '@/fetch/jina-fetch';
import { evaluateRobotsForUrl } from '@/fetch/robots-check';
import { discoverSitemapUrls } from '@/fetch/sitemap-discovery';
import type { CrawlTarget } from '@/core/types';
import { publicDns } from '../helpers';

// Every discovery path applies the same guards as the crawl path: no cross-port redirect, a bounded body read,
// a public address on every redirect hop, the target's own site for child sitemaps, and no credentials sent on.

const mixedDns = async (host: string) => (host === 'evil.example.net' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
const UA = 'T/1 (+https://t.example/bot)';
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

describe('safeFetch', () => {
  test('refuses a redirect to another port on the same host', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return String(input).includes(':8443') ? new Response('<urlset/>') : redirect('https://site.example.com:8443/sitemap.xml');
    }) as typeof fetch;
    const res = await safeFetch('https://site.example.com/sitemap.xml', fetchImpl, 'application/xml', { sameSiteAs: 'https://site.example.com', dnsLookup: publicDns });
    expect(res).toBeNull();
    expect(asked).toEqual(['https://site.example.com/sitemap.xml']);
  });

  test('allows the http to https upgrade', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) =>
      String(input).startsWith('http://') ? redirect('https://site.example.com/sitemap.xml') : new Response('<urlset/>')) as typeof fetch;
    const res = await safeFetch('http://site.example.com/sitemap.xml', fetchImpl, 'application/xml', { sameSiteAs: 'https://site.example.com', dnsLookup: publicDns });
    expect(res?.status).toBe(200);
  });

  test('a body that never ends is cut off at the timeout', async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
          },
        }),
      )) as typeof fetch;
    const res = await safeFetch('https://site.example.com/sitemap.xml', fetchImpl, 'application/xml', { dnsLookup: publicDns, timeoutMs: 100 });
    await expect(res!.text()).rejects.toBeDefined();
  });

  test('refuses a redirect whose host resolves to a private address', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return redirect('https://evil.example.net/x');
    }) as typeof fetch;
    const res = await safeFetch('https://site.example.com/x', fetchImpl, 'text/html', { dnsLookup: mixedDns });
    expect(res).toBeNull();
    expect(asked).toEqual(['https://site.example.com/x']);
  });
});

describe('robots.txt', () => {
  test('refuses a redirect whose host resolves to a private address', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return redirect('https://evil.example.net/robots.txt');
    }) as typeof fetch;
    const result = await evaluateRobotsForUrl('https://site.example.com/page', { fetchImpl, dnsLookup: mixedDns, userAgent: UA });
    expect(result.policy).toBe('unknown');
    expect(asked).toEqual(['https://site.example.com/robots.txt']);
  });
});

describe('sitemap index', () => {
  test('does not request a child sitemap on another site', async () => {
    const target: CrawlTarget = { baseUrl: 'https://site.example.com', robotsPolicy: 'allow', active: true };
    const asked: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      const xml = url.endsWith('/sitemap.xml')
        ? '<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://other.example.org/s.xml</loc></sitemap></sitemapindex>'
        : '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://site.example.com/a</loc></url></urlset>';
      return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } });
    }) as typeof fetch;
    await discoverSitemapUrls(target, { userAgent: UA, dnsLookup: publicDns });
    expect(asked.some((u) => u.includes('other.example.org'))).toBe(false);
  });
});

describe('Jina', () => {
  test('a URL with credentials is refused and nothing is sent', async () => {
    const fetchImpl = vi.fn(async () => new Response('Title: x\n\nMarkdown Content:\nhello'));
    const result = await fetchViaJina('https://user:secret@a.example.com/x', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
