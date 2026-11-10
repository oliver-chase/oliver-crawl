import { describe, expect, test } from 'vitest';
import { extractJsonLdEvent, extractAllJsonLdEvents } from '@/extract/jsonld-event';

describe('extractJsonLdEvent', () => {
  test('reads date/venue/price/lineup off a top-level Event node', () => {
    const script = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'MusicEvent',
      name: 'Summer Concert',
      startDate: '2026-08-21T19:00:00-04:00',
      location: { '@type': 'Place', name: 'Example Gazebo' },
      offers: { '@type': 'Offer', price: '25', priceCurrency: 'USD' },
      performer: [{ '@type': 'MusicGroup', name: 'The Locals' }, { '@type': 'MusicGroup', name: 'Second Act' }],
    });
    expect(extractJsonLdEvent([script])).toEqual({
      eventName: 'Summer Concert',
      dateText: 'August 21, 2026',
      venueName: 'Example Gazebo',
      priceText: '$25',
      lineup: ['The Locals', 'Second Act'],
      description: null,
      imageUrl: null,
    });
  });

  // The Event node's own description is a source-provided blurb, copied verbatim.
  test('reads the Event node\'s own description', () => {
    const script = JSON.stringify({
      '@type': 'Event',
      name: 'Summer Concert',
      startDate: '2026-08-21',
      description: 'An evening of live music by the canal, all ages welcome.',
    });
    expect(extractJsonLdEvent([script])?.description).toBe('An evening of live music by the canal, all ages welcome.');
  });

  // schema.org's `image` can be a bare URL string, an ImageObject, or an array
  // of either. It is kept as structured data for ICS, enrichment and dedup use.
  test('reads a bare image URL string', () => {
    const script = JSON.stringify({ '@type': 'Event', name: 'Summer Concert', startDate: '2026-08-21', image: 'https://example.com/flyer.jpg' });
    expect(extractJsonLdEvent([script])?.imageUrl).toBe('https://example.com/flyer.jpg');
  });

  test('reads an image URL from an ImageObject', () => {
    const script = JSON.stringify({
      '@type': 'Event', name: 'Summer Concert', startDate: '2026-08-21',
      image: { '@type': 'ImageObject', url: 'https://example.com/flyer.jpg' },
    });
    expect(extractJsonLdEvent([script])?.imageUrl).toBe('https://example.com/flyer.jpg');
  });

  test('reads the first image URL from an array of images', () => {
    const script = JSON.stringify({
      '@type': 'Event', name: 'Summer Concert', startDate: '2026-08-21',
      image: ['https://example.com/flyer1.jpg', 'https://example.com/flyer2.jpg'],
    });
    expect(extractJsonLdEvent([script])?.imageUrl).toBe('https://example.com/flyer1.jpg');
  });

  test('rejects an unsafe image URL (javascript:) instead of storing it', () => {
    const script = JSON.stringify({ '@type': 'Event', name: 'Summer Concert', startDate: '2026-08-21', image: 'javascript:alert(1)' });
    expect(extractJsonLdEvent([script])?.imageUrl).toBeNull();
  });

  test('formats a free event (price 0) as "Free"', () => {
    const script = JSON.stringify({
      '@type': 'Event',
      startDate: '2026-07-04',
      offers: { price: 0 },
    });
    expect(extractJsonLdEvent([script])?.priceText).toBe('Free');
  });

  test('formats a price range when offers list distinct prices', () => {
    const script = JSON.stringify({
      '@type': 'Event',
      startDate: '2026-07-04',
      offers: [{ price: 10 }, { price: 25 }],
    });
    expect(extractJsonLdEvent([script])?.priceText).toBe('$10-$25');
  });

  test('handles a single performer object (not an array)', () => {
    const script = JSON.stringify({
      '@type': 'Event',
      startDate: '2026-07-04',
      performer: { name: 'Solo Artist' },
    });
    expect(extractJsonLdEvent([script])?.lineup).toEqual(['Solo Artist']);
  });

  test('handles a bare string performer', () => {
    const script = JSON.stringify({ '@type': 'Event', startDate: '2026-07-04', performer: 'Solo Artist' });
    expect(extractJsonLdEvent([script])?.lineup).toEqual(['Solo Artist']);
  });

  test('handles a bare string location', () => {
    const script = JSON.stringify({ '@type': 'Event', startDate: '2026-07-04', location: 'The Barn' });
    expect(extractJsonLdEvent([script])?.venueName).toBe('The Barn');
  });

  test('finds an Event node nested inside an @graph array', () => {
    const script = JSON.stringify({
      '@graph': [
        { '@type': 'WebSite', name: 'Town Site' },
        { '@type': 'Event', name: 'Fall Festival', startDate: '2026-10-10' },
      ],
    });
    expect(extractJsonLdEvent([script])?.dateText).toBe('October 10, 2026');
  });

  test('matches a compound @type array containing "Event"', () => {
    const script = JSON.stringify({ '@type': ['Event', 'MusicEvent'], startDate: '2026-09-01' });
    expect(extractJsonLdEvent([script])?.dateText).toBe('September 1, 2026');
  });

  test('skips a malformed script and keeps checking the rest', () => {
    const scripts = ['{not valid json', JSON.stringify({ '@type': 'Event', startDate: '2026-06-15' })];
    expect(extractJsonLdEvent(scripts)?.dateText).toBe('June 15, 2026');
  });

  test('returns null when no script has an Event node', () => {
    const script = JSON.stringify({ '@type': 'Organization', name: 'Acme' });
    expect(extractJsonLdEvent([script])).toBeNull();
  });

  test('returns null for an empty script list', () => {
    expect(extractJsonLdEvent([])).toBeNull();
  });

  test('returns a null dateText for an unparseable startDate rather than throwing', () => {
    const script = JSON.stringify({ '@type': 'Event', startDate: 'not-a-date' });
    expect(extractJsonLdEvent([script])?.dateText).toBeNull();
  });

  test('returns null fields (not a crash) when Event node has no date/venue/price/lineup at all', () => {
    const script = JSON.stringify({ '@type': 'Event', name: 'Mystery Event' });
    expect(extractJsonLdEvent([script])).toEqual({
      eventName: 'Mystery Event',
      dateText: null,
      venueName: null,
      priceText: null,
      lineup: null,
      description: null,
      imageUrl: null,
    });
  });

  test('reads eventName off the node\'s own "name" field', () => {
    const script = JSON.stringify({ '@type': 'Event', name: 'Fall Festival', startDate: '2026-10-10' });
    expect(extractJsonLdEvent([script])?.eventName).toBe('Fall Festival');
  });

  test('returns a null eventName when the Event node has no name', () => {
    const script = JSON.stringify({ '@type': 'Event', startDate: '2026-07-04' });
    expect(extractJsonLdEvent([script])?.eventName).toBeNull();
  });

  // The date digits are read directly from the ISO string, so an evening start
  // with an offset keeps its own calendar day instead of the UTC day.
  test('an evening event with a non-UTC offset keeps its own calendar date, not the UTC-shifted one', () => {
    const script = JSON.stringify({ '@type': 'Event', startDate: '2026-08-21T20:00:00-04:00' });
    // 8pm Eastern on Aug 21 is midnight UTC on Aug 22 — must still read Aug 21.
    expect(extractJsonLdEvent([script])?.dateText).toBe('August 21, 2026');
  });

  test('a late-night offset event just past UTC midnight also keeps its own calendar date', () => {
    const script = JSON.stringify({ '@type': 'Event', startDate: '2026-12-31T23:30:00-05:00' });
    expect(extractJsonLdEvent([script])?.dateText).toBe('December 31, 2026');
  });

  // An Event node is used only when exactly one exists on the page, so a
  // "related event" widget or footer promo is never bound to the page's draft.
  test('returns null when the page has more than one Event-typed node — too ambiguous to pick one', () => {
    const script = JSON.stringify({
      '@graph': [
        { '@type': 'Event', name: 'Main Event', startDate: '2026-08-21' },
        { '@type': 'Event', name: 'Related Event (sidebar widget)', startDate: '2026-09-01' },
      ],
    });
    expect(extractJsonLdEvent([script])).toBeNull();
  });

  // An empty-string offer price (a "TBD" placeholder) is unknown, not "Free".
  test('an empty-string offer price is NOT treated as free/zero', () => {
    const script = JSON.stringify({ '@type': 'Event', startDate: '2026-07-04', offers: { price: '' } });
    expect(extractJsonLdEvent([script])?.priceText).toBeNull();
  });

  // An array-valued `location` (a valid schema.org shape) reads its first entry.
  test('an array-valued location reads the first entry\'s name', () => {
    const script = JSON.stringify({
      '@type': 'Event',
      startDate: '2026-07-04',
      location: [{ '@type': 'Place', name: 'Main Stage' }, { '@type': 'Place', name: 'Overflow Lawn' }],
    });
    expect(extractJsonLdEvent([script])?.venueName).toBe('Main Stage');
  });
});

// Aggregator and city-calendar pages commonly emit one JSON-LD Event node per
// listed event. extractAllJsonLdEvents returns every one of them with no
// ambiguity guard, because the caller feeds each into the dedup pipeline.
describe('extractAllJsonLdEvents', () => {
  test('returns fields for every Event node found, in document order', () => {
    const script = JSON.stringify({
      '@graph': [
        { '@type': 'Event', name: 'Farmers Market', startDate: '2026-08-01' },
        { '@type': 'Event', name: 'Movie Night', startDate: '2026-08-02' },
      ],
    });
    const events = extractAllJsonLdEvents([script]);
    expect(events).toHaveLength(2);
    expect(events[0]?.eventName).toBe('Farmers Market');
    expect(events[1]?.eventName).toBe('Movie Night');
  });

  test('returns an empty array when there is no Event node at all', () => {
    const script = JSON.stringify({ '@type': 'Organization', name: 'Acme' });
    expect(extractAllJsonLdEvents([script])).toEqual([]);
  });

  test('returns a single-element array for a page with exactly one Event node', () => {
    const script = JSON.stringify({ '@type': 'Event', name: 'Fall Festival', startDate: '2026-10-10' });
    expect(extractAllJsonLdEvents([script])).toHaveLength(1);
  });

  test('collects nodes across multiple separate script blocks', () => {
    const scripts = [
      JSON.stringify({ '@type': 'Event', name: 'Event A', startDate: '2026-08-01' }),
      JSON.stringify({ '@type': 'Event', name: 'Event B', startDate: '2026-08-02' }),
    ];
    expect(extractAllJsonLdEvents(scripts).map((e) => e.eventName)).toEqual(['Event A', 'Event B']);
  });

  test('skips a malformed script and keeps checking the rest', () => {
    const scripts = ['{not valid json', JSON.stringify({ '@type': 'Event', name: 'Valid Event', startDate: '2026-06-15' })];
    expect(extractAllJsonLdEvents(scripts).map((e) => e.eventName)).toEqual(['Valid Event']);
  });
});

describe('price text uses the offer currency', () => {
  const priceOf = (offers: unknown) =>
    extractJsonLdEvent([JSON.stringify({ '@type': 'Event', name: 'Show', startDate: '2026-07-11', offers })])?.priceText;

  test('euros and pounds keep their symbol, other currencies keep their code', () => {
    expect(priceOf({ price: '25', priceCurrency: 'EUR' })).toBe('€25');
    expect(priceOf({ price: '25', priceCurrency: 'gbp' })).toBe('£25');
    expect(priceOf({ price: '25', priceCurrency: 'CAD' })).toBe('25 CAD');
  });

  test('a missing currency is read as dollars, as before', () => {
    expect(priceOf({ price: '25' })).toBe('$25');
  });
});
