import { describe, expect, test, vi } from 'vitest';
import { discoverPaginatedUrls, findNextPageUrl } from '@/extract/pagination-discovery';
import { __clearDnsCacheForTests } from '@/fetch/host-policy';
import { publicDns } from '../helpers';

// Pagination follows the crawler's own controls: same site only, the caller's resolver and user agent.

const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

describe('discoverPaginatedUrls', () => {
  test('a rel=next link to another site is not followed', async () => {
    __clearDnsCacheForTests();
    const requested: string[] = [];
    const fetchImpl = (async (url: string) => {
      requested.push(url);
      return html('<a rel="next" href="https://other.example.net/page2">next</a>');
    }) as unknown as typeof fetch;
    const found = await discoverPaginatedUrls('https://site.example.com/events', { fetchImpl, dnsLookup: publicDns });
    expect(requested).toEqual(['https://site.example.com/events']);
    expect(found.every((url) => url.startsWith('https://site.example.com'))).toBe(true);
  });

  test('the caller user agent and resolver are used', async () => {
    __clearDnsCacheForTests();
    const dns = vi.fn(publicDns);
    let sent = '';
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sent = String((init?.headers as Record<string, string>)['User-Agent']);
      return html('<p>last page</p>');
    }) as unknown as typeof fetch;
    await discoverPaginatedUrls('https://site.example.com/events', { fetchImpl, dnsLookup: dns, userAgent: 'MyBot/2 (+https://example.com/bot)' });
    expect(sent).toBe('MyBot/2 (+https://example.com/bot)');
    expect(dns).toHaveBeenCalled();
  });
});

describe('findNextPageUrl', () => {
  test('skips an unusable rel=next candidate and returns the next usable one', () => {
    const page = '<a rel="next" href="javascript:void(0)">x</a><a rel="next" href="/events?page=2">next</a>';
    expect(findNextPageUrl(page, 'https://site.example.com/events')).toBe('https://site.example.com/events?page=2');
  });
});
