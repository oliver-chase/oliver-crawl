import { describe, expect, test } from 'vitest';
import * as cheerio from 'cheerio';
import { findContentImages } from '@/extract/content-images';
import { pickDetailLinks } from '@/extract/detail-link-picker';
import { diffContent } from '@/extract/content-diff';

const PAGE_URL = 'https://venue.example.com/events';

// CRAWL-VISION-1 — a flyer page is not an empty page
describe('findContentImages', () => {
  const $ = (html: string) => cheerio.load(html);

  test('prefers a content-region flyer over site furniture', () => {
    const found = findContentImages(
      $(`<body>
           <header><img src="/img/logo.png" width="400" height="400" alt="Venue"></header>
           <nav><img src="/icons/menu-icon.png" width="300" height="300" alt="Menu"></nav>
           <main><img src="/uploads/summer-flyer.jpg" width="800" height="1000" alt="Summer concert series lineup"></main>
         </body>`),
      PAGE_URL,
    );

    expect(found[0]!.url).toContain('summer-flyer.jpg');
    expect(found.map((i) => i.url).some((u) => u.includes('logo'))).toBe(false);
    expect(found.map((i) => i.url).some((u) => u.includes('icon'))).toBe(false);
  });

  test('resolves relative URLs against the page', () => {
    const found = findContentImages($('<main><img src="poster.jpg" width="800" height="1000" alt="A real poster"></main>'), PAGE_URL);
    expect(found[0]!.url).toBe('https://venue.example.com/poster.jpg');
  });

  test('skips declared-tiny images whatever they are called', () => {
    expect(findContentImages($('<main><img src="/uploads/x.jpg" width="20" height="20" alt="tiny"></main>'), PAGE_URL)).toEqual([]);
  });

  test('skips svg/gif/ico — never a scanned flyer', () => {
    expect(
      findContentImages($('<main><img src="/a.svg" width="900" height="900"><img src="/b.gif" width="900" height="900"></main>'), PAGE_URL),
    ).toEqual([]);
  });

  test('an ordinary text page yields nothing — the common, correct answer', () => {
    expect(findContentImages($('<main><p>Concerts every Friday at the riverside stage.</p></main>'), PAGE_URL)).toEqual([]);
  });

  test('a flyer-ish filename scores above a plain photo', () => {
    const found = findContentImages(
      $(`<main>
           <img src="/uploads/photo1.jpg" width="800" height="800" alt="A photo of the venue">
           <img src="/uploads/2026-poster.jpg" width="800" height="800" alt="A photo of the venue">
         </main>`),
      PAGE_URL,
    );
    expect(found[0]!.url).toContain('poster');
  });
});

// CRAWL-DETAILLINK-1 — mechanism ours, vocabulary the caller's
describe('pickDetailLinks', () => {
  const links = [
    { url: 'https://venue.example.com/visit/parking', text: 'Parking & Directions' },
    { url: 'https://venue.example.com/tickets', text: 'Buy tickets' },
    { url: 'https://venue.example.com/about', text: 'About us' },
  ];

  test('matches a field to its most likely link', () => {
    const picks = pickDetailLinks(links, { parking: ['parking'], price: ['ticket', 'admission'] });
    const byField = Object.fromEntries(picks.map((p) => [p.field, p.link.url]));

    expect(byField.parking).toContain('/visit/parking');
    expect(byField.price).toContain('/tickets');
  });

  test('anchor text outweighs a path coincidence', () => {
    // The author naming the link is stronger evidence than a path segment.
    const picks = pickDetailLinks(
      [
        { url: 'https://venue.example.com/parking/archive/2019', text: 'Old news archive' },
        { url: 'https://venue.example.com/p/9', text: 'Parking information' },
      ],
      { parking: ['parking'] },
    );
    expect(picks[0]!.link.url).toContain('/p/9');
  });

  test('returns one link per field, not three guesses', () => {
    const picks = pickDetailLinks(links, { price: ['ticket', 'buy'] });
    expect(picks.filter((p) => p.field === 'price')).toHaveLength(1);
  });

  test('no match yields nothing rather than a bad guess', () => {
    expect(pickDetailLinks(links, { catering: ['catering', 'banquet'] })).toEqual([]);
  });
});

// BETTER-DIFF-1 — pay to re-extract the delta, not the page
describe('diffContent', () => {
  test('identical content reports no change', () => {
    const md = '## Shows\n\n- July 11 The Hold Steady\n\n- July 18 Waxahatchee';
    expect(diffContent(md, md).changed).toBe(false);
  });

  test('one added block is reported alone', () => {
    const before = '## Shows\n\n- July 11 The Hold Steady';
    const after = '## Shows\n\n- July 11 The Hold Steady\n\n- July 25 Big Thief';

    const diff = diffContent(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.added).toEqual(['- July 25 Big Thief']);
    expect(diff.removed).toEqual([]);
  });

  test('a removed block is reported', () => {
    const diff = diffContent('## Shows\n\n- July 11 A\n\n- July 18 B', '## Shows\n\n- July 18 B');
    expect(diff.removed).toEqual(['- July 11 A']);
    expect(diff.added).toEqual([]);
  });

  test('reordering is NOT a content change', () => {
    // The failure a positional diff has: inserting at the top shifts every
    // line and reports the whole page as changed.
    const before = '- A\n\n- B\n\n- C';
    const after = '- C\n\n- A\n\n- B';
    expect(diffContent(before, after).changed).toBe(false);
  });

  test('an inserted first item reports exactly one addition', () => {
    const before = '- A\n\n- B';
    const after = '- NEW\n\n- A\n\n- B';
    const diff = diffContent(before, after);
    expect(diff.added).toEqual(['- NEW']);
    expect(diff.removed).toEqual([]);
  });

  test('duplicate blocks are counted, not collapsed', () => {
    const diff = diffContent('- A\n\n- A', '- A\n\n- A\n\n- A');
    expect(diff.added).toEqual(['- A']);
  });

  test('changes lists additions then removals', () => {
    const diff = diffContent('- old', '- new');
    expect(diff.changes).toEqual([
      { kind: 'added', text: '- new' },
      { kind: 'removed', text: '- old' },
    ]);
  });
});
