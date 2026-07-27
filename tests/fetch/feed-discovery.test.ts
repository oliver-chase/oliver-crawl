import { describe, expect, test, vi } from 'vitest';

vi.mock('@/fetch/host-policy', () => ({
  assertHostResolvesToPublicAddress: vi.fn().mockResolvedValue(undefined),
}));

import { parseFeedLinksFromHtml, candidateIcsUrls, discoverIcsFeed, googleCalendarIcsCandidates } from '@/fetch/feed-discovery';

describe('parseFeedLinksFromHtml', () => {
  test('extracts a text/calendar alternate link (absolute)', () => {
    const html = '<head><link rel="alternate" type="text/calendar" href="https://x.com/feed.ics"></head>';
    expect(parseFeedLinksFromHtml(html, 'https://x.com/events')).toEqual(['https://x.com/feed.ics']);
  });

  test('resolves a relative href against the page URL', () => {
    const html = '<link rel="alternate" type="text/calendar" href="/cal/events.ics">';
    expect(parseFeedLinksFromHtml(html, 'https://x.com/events/')).toEqual(['https://x.com/cal/events.ics']);
  });

  test('picks up rel=alternate with a .ics href even without the calendar type', () => {
    const html = '<link rel="alternate" href="https://x.com/a.ics?x=1">';
    expect(parseFeedLinksFromHtml(html, 'https://x.com/')).toEqual(['https://x.com/a.ics?x=1']);
  });

  test('ignores non-calendar alternates (rss) and non-alternate links', () => {
    const html =
      '<link rel="alternate" type="application/rss+xml" href="/rss">' +
      '<link rel="stylesheet" href="/a.css">' +
      '<link rel="canonical" href="/page">';
    expect(parseFeedLinksFromHtml(html, 'https://x.com/')).toEqual([]);
  });
});

describe('candidateIcsUrls', () => {
  test('includes ?ical=1 on the page path and /events, /calendar', () => {
    const c = candidateIcsUrls('https://venue.com/whats-on/');
    expect(c).toContain('https://venue.com/whats-on/?ical=1');
    expect(c).toContain('https://venue.com/events?ical=1');
    expect(c).toContain('https://venue.com/calendar?ical=1');
  });
  test('includes Squarespace ?format=ical and bare .ics paths', () => {
    const c = candidateIcsUrls('https://venue.com/events');
    expect(c).toContain('https://venue.com/events?format=ical');
    expect(c).toContain('https://venue.com/events.ics');
  });
  test('invalid URL = no candidates', () => {
    expect(candidateIcsUrls('nonsense')).toEqual([]);
  });
});

describe('discoverIcsFeed', () => {
  const ICS = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:x\nEND:VEVENT\nEND:VCALENDAR';

  test('returns the source URL when it already serves ICS', async () => {
    const fetchImpl = (async () =>
      new Response(ICS, { status: 200, headers: { 'content-type': 'text/calendar' } })) as unknown as typeof fetch;
    const r = await discoverIcsFeed('https://venue.com/feed.ics', { fetchImpl });
    expect(r.feedUrl).toBe('https://venue.com/feed.ics');
  });

  test('discovers a feed declared in the page head', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = url.toString();
      if (u === 'https://venue.com/events') {
        return new Response('<link rel="alternate" type="text/calendar" href="/real.ics">', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (u === 'https://venue.com/real.ics') {
        return new Response(ICS, { status: 200, headers: { 'content-type': 'text/calendar' } });
      }
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const r = await discoverIcsFeed('https://venue.com/events', { fetchImpl });
    expect(r.feedUrl).toBe('https://venue.com/real.ics');
  });

  test('falls back to a common platform path (?ical=1)', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = url.toString();
      if (u === 'https://venue.com/events?ical=1') {
        return new Response(ICS, { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      if (u === 'https://venue.com/events') {
        return new Response('<html>no feed link here</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const r = await discoverIcsFeed('https://venue.com/events', { fetchImpl });
    expect(r.feedUrl).toBe('https://venue.com/events?ical=1');
  });

  test('no feed anywhere = null (fails closed)', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = url.toString();
      if (u === 'https://venue.com/events') {
        return new Response('<html>plain page</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    const r = await discoverIcsFeed('https://venue.com/events', { fetchImpl });
    expect(r.feedUrl).toBeNull();
  });
});

// DETERMINISM-1b: Google Calendar embed -> derived public ICS candidates.
describe('googleCalendarIcsCandidates', () => {
  test('derives the public ICS URL from an embed iframe src (entity-encoded query too)', () => {
    const html = '<iframe src="https://calendar.google.com/calendar/embed?height=600&amp;src=abc123%40group.calendar.google.com&amp;ctz=America%2FDenver"></iframe>';
    const candidates = googleCalendarIcsCandidates(html);
    expect(candidates).toContain('https://calendar.google.com/calendar/ical/abc123%40group.calendar.google.com/public/basic.ics');
  });

  test('multiple src params yield one candidate each', () => {
    const html = '<iframe src="https://calendar.google.com/calendar/embed?src=one%40gmail.com&src=two%40group.calendar.google.com"></iframe>';
    const candidates = googleCalendarIcsCandidates(html);
    expect(candidates).toHaveLength(2);
  });

  test('direct public basic.ics links are picked up; plain pages yield none', () => {
    expect(googleCalendarIcsCandidates('<a href="https://calendar.google.com/calendar/ical/x%40y/public/basic.ics">cal</a>')).toHaveLength(1);
    expect(googleCalendarIcsCandidates('<html><body>no calendars here</body></html>')).toHaveLength(0);
  });
});
