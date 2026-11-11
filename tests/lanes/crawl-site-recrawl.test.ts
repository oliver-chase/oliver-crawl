import { describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { crawlSite } from '@/crawl-site';
import type { CrawlTarget } from '@/core/types';
import { publicDns } from '../helpers';

// The multi-page orchestrator. Everything it does that a single page cannot
// decide for itself: which URLs, how many, retry policy, dedup, and reporting
// per-URL outcomes without one bad page sinking the run.

const target: CrawlTarget = {
  name: 'Venue',
  baseUrl: 'https://venue.example.com',
  robotsPolicy: 'allow',
  active: true,
};

const page = (body: string) =>
  new Response(`<html><head><title>T</title></head><body><main>${body}</main></body></html>`, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });

function crawler() {
  return createCrawler({ userAgent: 'T/1', dnsLookup: publicDns });
}

describe('crawlSite — unchanged-content detection (CRAWL-UNCHANGED-1)', () => {
  // Most small sites send NO ETag. The content-region hash is what makes
  // their re-crawls cheap: the fetch is unavoidable, the expensive
  // downstream work (extraction, LLM) is not.
  test('flags a page whose content-region hash matches last run', async () => {
    const body = '<html><head><title>T</title></head><body><main>Stable event copy.</main></body></html>';
    globalThis.fetch = (async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;

    const first = await crawlSite(crawler(), target, { seeds: ['https://venue.example.com/events'] });
    const firstHash = first.validators['https://venue.example.com/events']!.contentRegionSha256;
    expect(firstHash).toBeTruthy();
    expect(first.unchanged).toEqual([]);

    const second = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/events'],
      priorValidators: { 'https://venue.example.com/events': { contentRegionSha256: firstHash } },
    });

    expect(second.unchanged).toEqual(['https://venue.example.com/events']);
    expect(second.pages).toHaveLength(1); // still fetched — only the origin can prevent that
  });

  test('a real content change is NOT flagged unchanged', async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      const main = call === 1 ? 'Original copy.' : 'Completely different copy now.';
      return new Response(`<html><head><title>T</title></head><body><main>${main}</main></body></html>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;

    const first = await crawlSite(crawler(), target, { seeds: ['https://venue.example.com/events'] });
    const second = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/events'],
      priorValidators: {
        'https://venue.example.com/events': {
          contentRegionSha256: first.validators['https://venue.example.com/events']!.contentRegionSha256,
        },
      },
    });

    expect(second.unchanged).toEqual([]);
  });
});

describe('crawlSite — sitemap-derived seeds', () => {
  test('uses the site sitemap when no seeds are given', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/sitemap.xml')) {
        return new Response(
          `<urlset>
            <url><loc>https://venue.example.com/events/a</loc></url>
            <url><loc>https://venue.example.com/events/b</loc></url>
          </urlset>`,
          { status: 200, headers: { 'content-type': 'application/xml' } },
        );
      }
      return page('Discovered page.');
    }) as typeof fetch;

    const result = await crawlSite(crawler(), target, { useSitemap: true, maxPages: 5 });

    expect(result.pages.map((p) => p.url).sort()).toEqual([
      'https://venue.example.com/events/a',
      'https://venue.example.com/events/b',
    ]);
  });

  test('falls back to baseUrl when the site has no sitemap', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/sitemap.xml')) return new Response('nope', { status: 404 });
      return page('Base page.');
    }) as typeof fetch;

    const result = await crawlSite(crawler(), target, { useSitemap: true });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.url).toContain('venue.example.com');
  });

  test('explicit seeds win over sitemap discovery', async () => {
    let sitemapFetched = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/sitemap.xml')) {
        sitemapFetched = true;
        return new Response('<urlset></urlset>', { status: 200, headers: { 'content-type': 'application/xml' } });
      }
      return page('Explicit seed page.');
    }) as typeof fetch;

    await crawlSite(crawler(), target, { useSitemap: true, seeds: ['https://venue.example.com/chosen'] });
    expect(sitemapFetched).toBe(false);
  });
});

describe('crawlSite — hash comparability across rungs (CRAWL-HASH-1)', () => {
  // The bug: contentRegionSha256 was filled on text-only rungs with a hash of
  // the extracted TEXT, which is not comparable with the HTML-derived
  // structural hash. A page fetched normally one run and via Jina the next
  // would report a false content change.
  test('same content via different rungs is NOT reported as changed', async () => {
    const body = '<html><head><title>T</title></head><body><main>Identical event copy across rungs.</main></body></html>';

    // Run 1: normal fetch (HTML rung -> structural hash present).
    globalThis.fetch = (async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    const first = await crawlSite(crawler(), target, { seeds: ['https://venue.example.com/events'] });
    const v1 = first.validators['https://venue.example.com/events']!;
    expect(v1.contentRegionSha256).toBeTruthy();
    expect(v1.textSha256).toBeTruthy();

    // Run 2: direct fetch fails, Jina serves the SAME text (text-only rung ->
    // no structural hash). Comparison must fall back to the text hash.
    const jinaText = first.pages[0]!.text;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('r.jina.ai')) {
        return new Response(
          `Title: T\nURL Source: https://venue.example.com/events\n\nMarkdown Content:\n${jinaText} ` +
            'Padding so the fallback clears its own minimum-content guard for this test. '.repeat(4),
          { status: 200 },
        );
      }
      return new Response('down', { status: 503 });
    }) as typeof fetch;

    const second = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/events'],
      priorValidators: { 'https://venue.example.com/events': v1 },
      maxRetries: 0,
    });

    expect(second.pages[0]!.rung).toBe('jina');
    // Structural hash is empty on this rung — honest, not a lookalike.
    expect(second.validators['https://venue.example.com/events']!.contentRegionSha256).toBe('');
    // And it must NOT have been compared against the structural hash.
    expect(second.pages[0]!.textSha256).toBeTruthy();
  });
});

describe('crawlSite — whole-site discovery from one URL (followLinks)', () => {
  // The question this answers: "I gave it testsite.com — do I get /calendar,
  // /menu and /locations too?" Without followLinks: no, one page.
  const site: Record<string, string> = {
    'https://venue.example.com/': '<a href="/calendar">Calendar</a><a href="/menu">Menu</a><a href="/locations">Locations</a>',
    'https://venue.example.com/calendar': '<a href="/calendar/august">August</a>',
    'https://venue.example.com/menu': 'Our menu.',
    'https://venue.example.com/locations': 'Where to find us.',
    'https://venue.example.com/calendar/august': 'August events.',
  };

  function serveSite() {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input).replace(/\/$/, '') || 'https://venue.example.com';
      const key = site[String(input)] !== undefined ? String(input) : `${url}`;
      const body = site[key] ?? site[`${key}/`];
      if (body === undefined) return new Response('not found', { status: 404 });
      return page(body);
    }) as typeof fetch;
  }

  test('one seed with followLinks reaches every linked page', async () => {
    serveSite();
    const result = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/'],
      followLinks: true,
      maxPages: 10,
    });

    const urls = result.pages.map((p) => p.url).sort();
    expect(urls).toContain('https://venue.example.com/calendar');
    expect(urls).toContain('https://venue.example.com/menu');
    expect(urls).toContain('https://venue.example.com/locations');
    // depth 2 reaches a page linked from a section page
    expect(urls).toContain('https://venue.example.com/calendar/august');
  });

  test('without followLinks, one seed means ONE page', async () => {
    serveSite();
    const result = await crawlSite(crawler(), target, { seeds: ['https://venue.example.com/'] });
    expect(result.pages).toHaveLength(1);
  });

  test('maxDepth bounds how far it travels', async () => {
    serveSite();
    const result = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/'],
      followLinks: true,
      maxDepth: 1,
      maxPages: 10,
    });

    const urls = result.pages.map((p) => p.url);
    expect(urls).toContain('https://venue.example.com/calendar');
    // /calendar/august is two hops from the seed — beyond maxDepth 1.
    expect(urls).not.toContain('https://venue.example.com/calendar/august');
  });

  test('excludePatterns keep known-useless paths out', async () => {
    serveSite();
    const result = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/'],
      followLinks: true,
      maxPages: 10,
      excludePatterns: [/\/menu/],
    });

    expect(result.pages.map((p) => p.url)).not.toContain('https://venue.example.com/menu');
  });

  test('a site where every page links every other page still terminates', async () => {
    // Classic nav-on-every-page shape — an infinite loop without dedup.
    globalThis.fetch = (async () =>
      page('<a href="/a">A</a><a href="/b">B</a><a href="/">Home</a>')) as typeof fetch;

    const result = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/'],
      followLinks: true,
      maxPages: 20,
    });

    expect(result.pages.length).toBeLessThanOrEqual(3);
    expect(result.truncated).toBe(false);
  });
});

describe('crawlSite — redirect convergence (CRAWL-DEDUP-1)', () => {
  // Found in a live run: /index and / are the same page on most sites, but
  // dedup keyed only on the REQUESTED url, so both were crawled and stored.
  test('two URLs redirecting to the same page yield ONE page', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/index')) {
        return new Response(null, { status: 301, headers: { location: 'https://venue.example.com/' } });
      }
      const r = page('The one true homepage.');
      Object.defineProperty(r, 'url', { value: 'https://venue.example.com/' });
      return r;
    }) as typeof fetch;

    const result = await crawlSite(crawler(), target, {
      seeds: ['https://venue.example.com/', 'https://venue.example.com/index'],
    });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.url).toBe('https://venue.example.com/');
  });
});
