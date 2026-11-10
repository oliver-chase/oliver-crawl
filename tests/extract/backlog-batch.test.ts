import { describe, expect, test } from 'vitest';
import * as cheerio from 'cheerio';
import { findContentImages } from '@/extract/content-images';
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
           <main><img src="/uploads/summer-flyer.jpg" width="800" height="1000" alt="Outdoor concert series lineup"></main>
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

describe('diffContent', () => {
  test('identical content reports no change', () => {
    const md = '## Shows\n\n- July 11 Test Band A\n\n- July 18 Test Band B';
    expect(diffContent(md, md).changed).toBe(false);
  });

  test('one added block is reported alone', () => {
    const before = '## Shows\n\n- July 11 Test Band A';
    const after = '## Shows\n\n- July 11 Test Band A\n\n- July 25 Test Band C';

    const diff = diffContent(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.added).toEqual(['- July 25 Test Band C']);
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


  test('a change on a very long page is still reported as changed', () => {
    const blocks = Array.from({ length: 2_500 }, (_, index) => `Block number ${index}`).join('\n\n');
    const diff = diffContent(blocks, `${blocks}\n\nA new final block`);
    expect(diff.changed).toBe(true);
    expect(diff.added).toEqual(['A new final block']);
    expect(diff.truncated).toBe(false);
  });

  test('a wholesale rewrite reports a capped list and says it was cut', () => {
    const make = (prefix: string) => Array.from({ length: 2_500 }, (_, index) => `${prefix} ${index}`).join('\n\n');
    const diff = diffContent(make('old'), make('new'));
    expect(diff.changed).toBe(true);
    expect(diff.truncated).toBe(true);
    expect(diff.added).toHaveLength(2_000);
  });
});
