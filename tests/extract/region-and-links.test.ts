import * as cheerio from 'cheerio';
import { describe, expect, test } from 'vitest';
import { htmlToMarkdown } from '@/extract/html-to-markdown';
import { computeContentRegionHash } from '@/extract/content-region-hash';
import { findContentImages } from '@/extract/content-images';
import { buildPage } from '@/fetch/build-page';

// A page keeps all of its content, the change hash reads what the markdown reads, and links come out absolute.

const para = (text: string) => `<p>${text} is on the program this week at the riverside stage for everyone.</p>`;
const md = (html: string) => htmlToMarkdown(cheerio.load(html), { baseUrl: 'https://venue.example/' });
const base = {
  url: 'https://a.example.com/events/', contentType: 'text/html', etag: null, lastModified: null, baseHost: 'a.example.com',
  maxTextChars: 5000, rung: 'fetch', includeHtml: false, maxLinks: 10, maxOutboundHosts: 10,
};

describe('no content is dropped', () => {
  test('two articles of equal weight are both kept', () => {
    const out = md(`<html><body><div><article>${para('Alpha concert')}</article><article>${para('Beta concert')}</article></div></body></html>`);
    expect(out).toContain('Alpha');
    expect(out).toContain('Beta');
  });

  test('event blocks beside a long post are kept', () => {
    const out = md(`<html><body><div class="post">${para('Long post one')}${para('and two')}</div><div>${para('Event A')}</div><div>${para('Event B')}</div></body></html>`);
    expect(out).toContain('Event A');
    expect(out).toContain('Event B');
  });

  test('one dominant content block is still chosen over a minor sibling', () => {
    const many = Array.from({ length: 8 }, (_, i) => para(`Main story ${i + 1}`)).join('');
    const out = md(`<html><body><div class="content">${many}</div><div class="side">${para('Side note')}</div></body></html>`);
    expect(out).toContain('Main story 1');
    expect(out).not.toContain('Side note');
  });
});

describe('the change hash reads the region the markdown reads', () => {
  const three = (middle: string) =>
    `<html><body><article>${para('One')}</article><article>${para(middle)}</article><article>${para('Three')}</article></body></html>`;

  test('an edit to the middle of three articles changes both', async () => {
    expect(await computeContentRegionHash(three('Two original'))).not.toBe(await computeContentRegionHash(three('Two edited')));
    const a = await buildPage({ ...base, html: three('Two original') });
    const b = await buildPage({ ...base, html: three('Two edited') });
    if ('quarantined' in a || 'quarantined' in b) throw new Error('unexpected quarantine');
    expect(a.markdown).not.toBe(b.markdown);
  });

  test('a change in the nav alone changes neither', async () => {
    const page = (nav: string) => `<html><body><nav>${nav}</nav><main>${para('Stable content')}</main></body></html>`;
    expect(await computeContentRegionHash(page('Mon'))).toBe(await computeContentRegionHash(page('Tue')));
  });
});

describe('tables, images and links', () => {
  test('a nested table does not repeat its rows in the outer table', () => {
    const out = md('<html><body><main><table><tr><td>Layout</td><td>x</td></tr><tr><td><table><tr><td>Fri</td><td>7 PM</td></tr><tr><td>Sat</td><td>8 PM</td></tr></table></td><td>y</td></tr></table></main></body></html>');
    expect((out.match(/Fri/g) ?? []).length).toBe(1);
  });

  test('a lazy-loaded image is found by its data-src', () => {
    const html = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/img/flyer.png" alt="Summer flyer for the riverside stage concerts">';
    expect(findContentImages(cheerio.load(html), 'https://a.example.com/').map((i) => i.url)).toEqual(['https://a.example.com/img/flyer.png']);
  });

  test('image paths with spaces and brackets are escaped', () => {
    const out = md('<html><body><main><img src="/img/flyer (1).png" alt="Flyer"></main></body></html>');
    expect(out).toContain('![Flyer](https://venue.example/img/flyer%20%281%29.png)');
  });
});

describe('the content-region hash reads what the Markdown shows', () => {
  test('a changed link target changes the hash', async () => {
    const page = (href: string) => `<main><p>Tickets <a href="${href}">Buy</a></p></main>`;
    expect(await computeContentRegionHash(page('/t/1'), 'https://venue.example/')).not.toBe(await computeContentRegionHash(page('/t/2'), 'https://venue.example/'));
  });

  test('two blocks stay separate', async () => {
    expect(await computeContentRegionHash('<main><p>Doors</p><p>7 PM</p></main>')).not.toBe(await computeContentRegionHash('<main><p>Doors7 PM</p></main>'));
  });
});

describe('a main container with a nested scoring block keeps both', () => {
  test('the outer container keeps its own paragraphs', () => {
    const p = (t: string) => `<p>${t} with enough words to count as a real paragraph of prose.</p>`;
    const html = `<body><div id="sidebar">${p('Unrelated sidebar note')}</div><div class="post">${p('Outer one')}${p('Outer two')}${p('Outer three')}<section>${p('Inner one')}${p('Inner two')}</section></div></body>`;
    const out = md(html);
    expect(out).toContain('Outer one');
    expect(out).toContain('Inner one');
  });
});
