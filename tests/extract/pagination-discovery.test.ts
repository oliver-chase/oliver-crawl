import { describe, expect, test, vi } from 'vitest';

vi.mock('@/fetch/host-policy', () => ({
  assertHostResolvesToPublicAddress: vi.fn().mockResolvedValue(undefined),
}));

import { findNextPageUrl, discoverPaginatedUrls } from '@/extract/pagination-discovery';

describe('findNextPageUrl', () => {
  test('finds an explicit rel="next" anchor (the unambiguous signal)', () => {
    const html = '<a href="/events?page=2" rel="next">Older Shows &raquo;</a>';
    expect(findNextPageUrl(html, 'https://v.com/events')).toBe('https://v.com/events?page=2');
  });

  test('finds a <link rel="next"> in the head (also a valid HTML5 pagination convention)', () => {
    const html = '<head><link rel="next" href="https://v.com/events?page=2"></head>';
    expect(findNextPageUrl(html, 'https://v.com/events')).toBe('https://v.com/events?page=2');
  });

  test('falls back to an exact label match ("Older Events") when no rel="next" exists', () => {
    const html = '<a href="/events?page=2">Older Events</a>';
    expect(findNextPageUrl(html, 'https://v.com/events')).toBe('https://v.com/events?page=2');
  });

  test('falls back to "Load More" as a known pagination phrase', () => {
    const html = '<a href="/events?page=2">Load More</a>';
    expect(findNextPageUrl(html, 'https://v.com/events')).toBe('https://v.com/events?page=2');
  });

  test('does NOT match a real event whose title happens to contain "Next" (the false-positive risk)', () => {
    const html = '<a href="/events/next-level-comedy-night">Next Level Comedy Night</a>';
    expect(findNextPageUrl(html, 'https://v.com/events')).toBeNull();
  });

  // Code-review finding: a word-boundary check on "rel" also matches inside
  // data-rel (a hyphen is a word boundary too) — a real pattern from
  // carousel/slider JS plugins ("next slide"), wholly unrelated to page-level
  // pagination.
  test('does NOT mistake data-rel="next" (a carousel "next slide" control) for real pagination', () => {
    const html = '<a data-rel="next" class="carousel-control" href="/gallery/photo-2">Next photo</a>';
    expect(findNextPageUrl(html, 'https://v.com/events')).toBeNull();
  });

  test('no pagination link anywhere: null', () => {
    expect(findNextPageUrl('<a href="/about">About</a><a href="/contact">Contact</a>', 'https://v.com/events')).toBeNull();
  });

  test('resolves a relative href against the page URL', () => {
    const html = '<a href="page/2" rel="next">Next</a>';
    expect(findNextPageUrl(html, 'https://v.com/events/')).toBe('https://v.com/events/page/2');
  });
});

describe('discoverPaginatedUrls', () => {
  test('follows a real 3-page chain (page 1 -> 2 -> 3), returning pages 2 and 3', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u === 'https://v.com/events') return new Response('<a href="/events?page=2" rel="next">Older</a>', { status: 200 });
      if (u === 'https://v.com/events?page=2') return new Response('<a href="/events?page=3" rel="next">Older</a>', { status: 200 });
      if (u === 'https://v.com/events?page=3') return new Response('<p>no more pages</p>', { status: 200 });
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const urls = await discoverPaginatedUrls('https://v.com/events', { fetchImpl });
    expect(urls).toEqual(['https://v.com/events?page=2', 'https://v.com/events?page=3']);
  });

  test('stops at the cap even if pagination keeps going past page 3', async () => {
    let calls = 0;
    const fetchImpl = (async (_url: string | URL) => {
      calls += 1;
      const n = calls + 1;
      return new Response(`<a href="/events?page=${n + 1}" rel="next">Older</a>`, { status: 200 });
    }) as unknown as typeof fetch;
    const urls = await discoverPaginatedUrls('https://v.com/events', { fetchImpl });
    expect(urls).toHaveLength(2); // MAX_ADDITIONAL_PAGES — seed + 2 = "capped 3 pages" per spec
  });

  test('a page that loops back to an already-visited URL stops (not an infinite/circular walk)', async () => {
    const fetchImpl = (async () => new Response('<a href="/events" rel="next">Next</a>', { status: 200 })) as unknown as typeof fetch;
    const urls = await discoverPaginatedUrls('https://v.com/events', { fetchImpl });
    expect(urls).toEqual([]); // page 1's own "next" link points back at itself
  });

  test('no pagination link on the seed page: empty, not an error', async () => {
    const fetchImpl = (async () => new Response('<p>single page, no pagination</p>', { status: 200 })) as unknown as typeof fetch;
    expect(await discoverPaginatedUrls('https://v.com/events', { fetchImpl })).toEqual([]);
  });

  test('a fetch failure fails soft to whatever was found before it, never throws', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u === 'https://v.com/events') return new Response('<a href="/events?page=2" rel="next">Older</a>', { status: 200 });
      return new Response('server error', { status: 500 });
    }) as unknown as typeof fetch;
    await expect(discoverPaginatedUrls('https://v.com/events', { fetchImpl })).resolves.toEqual(['https://v.com/events?page=2']);
  });
});
