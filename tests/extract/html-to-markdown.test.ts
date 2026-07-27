import { describe, expect, test } from 'vitest';
import * as cheerio from 'cheerio';
import { htmlToMarkdown } from '@/extract/html-to-markdown';

// VENDOR-PARITY-1: markdown is an accuracy lever, not a format preference.
// Each case below is structure an extractor needs that plain text destroys.

const md = (html: string) => htmlToMarkdown(cheerio.load(html));

describe('structure the page author encoded survives', () => {
  test('headings keep their level', () => {
    expect(md('<main><h1>Venue</h1><h2>Summer Series</h2><h3>July</h3></main>')).toBe(
      '# Venue\n\n## Summer Series\n\n### July',
    );
  });

  test('a schedule table keeps its columns', () => {
    // The case that motivated this: flattened, "7:00 PM" loses the column
    // that says whether it is a door time or a start time.
    const out = md(`<main><table>
      <tr><th>Date</th><th>Artist</th><th>Time</th></tr>
      <tr><td>July 11</td><td>The Hold Steady</td><td>7:00 PM</td></tr>
      <tr><td>July 18</td><td>Waxahatchee</td><td>7:30 PM</td></tr>
    </table></main>`);

    expect(out).toContain('| Date | Artist | Time |');
    expect(out).toContain('| --- | --- | --- |');
    expect(out).toContain('| July 11 | The Hold Steady | 7:00 PM |');
    expect(out).toContain('| July 18 | Waxahatchee | 7:30 PM |');
  });

  test('lists keep items separate', () => {
    expect(md('<main><ul><li>Free parking</li><li>No coolers</li></ul></main>')).toBe('- Free parking\n- No coolers');
  });

  test('ordered lists are numbered', () => {
    expect(md('<main><ol><li>Arrive</li><li>Check in</li></ol></main>')).toBe('1. Arrive\n2. Check in');
  });

  test('links keep text attached to href', () => {
    expect(md('<main><p>See the <a href="/calendar">full calendar</a> online.</p></main>')).toBe(
      'See the [full calendar](/calendar) online.',
    );
  });

  test('image alt text is kept', () => {
    // Often the ONLY description of a flyer.
    expect(md('<main><img src="/flyer.jpg" alt="Concert July 11 at 7pm"></main>')).toBe(
      '![Concert July 11 at 7pm](/flyer.jpg)',
    );
  });

  test('emphasis is preserved', () => {
    expect(md('<main><p>Doors at <strong>6pm</strong>, show at <em>7pm</em>.</p></main>')).toBe(
      'Doors at **6pm**, show at *7pm*.',
    );
  });
});

describe('page chrome never reaches the model', () => {
  test('nav, header, footer and aside are dropped', () => {
    const out = md(`<body>
      <header>SITE HEADER</header>
      <nav><a href="/x">NAV LINK</a></nav>
      <main><p>The real event content.</p></main>
      <aside>SIDEBAR PROMO</aside>
      <footer>COPYRIGHT 2026</footer>
    </body>`);

    expect(out).toBe('The real event content.');
  });

  test('scripts and styles are dropped', () => {
    expect(md('<main><script>var x=1</script><style>p{}</style><p>Content.</p></main>')).toBe('Content.');
  });

  test('falls back to body when there is no main or article', () => {
    const out = md('<body><nav>NAV</nav><p>Only content.</p></body>');
    expect(out).toBe('Only content.');
    expect(out).not.toContain('NAV');
  });
});

describe('does not corrupt the surrounding crawl', () => {
  test('the source tree is not mutated — links survive for the link pass', () => {
    // The bug this guards: stripping chrome in place would delete every nav
    // link, and a site's calendar link is usually IN the nav.
    const $ = cheerio.load('<body><nav><a href="/calendar">Calendar</a></nav><main><p>Hi there friend.</p></main></body>');
    htmlToMarkdown($);
    expect($('a[href="/calendar"]').length).toBe(1);
  });

  test('markdown syntax in page text is escaped, not executed', () => {
    expect(md('<main><p>Rated 5*stars* and [bracketed]</p></main>')).toContain('\\*');
  });

  test('a pipe inside a table cell does not break the row', () => {
    const out = md('<main><table><tr><th>A</th></tr><tr><td>x | y</td></tr></table></main>');
    expect(out).toContain('x \\| y');
  });

  test('respects maxChars', () => {
    const long = `<main><p>${'Concerts every Friday at the riverside stage. '.repeat(200)}</p></main>`;
    const out = htmlToMarkdown(cheerio.load(long), { maxChars: 100 });
    expect(out).toContain('[TRUNCATED]');
    expect(out.length).toBeLessThan(200);
  });

  test('an empty page yields an empty string, not a throw', () => {
    expect(md('<body></body>')).toBe('');
  });
});

describe('PARITY-READABILITY-1 — div-soup pages without semantic tags', () => {
  test('the prose cluster beats the link farm', () => {
    // No <main>, no <article> — the shape readability scoring exists for.
    const out = md(`<body>
      <div id="wrap">
        <div id="sidebar">
          <p><a href="/a">Concerts</a> <a href="/b">Tickets</a> <a href="/c">Parking</a> <a href="/d">About us page</a></p>
          <p><a href="/e">Newsletter signup</a> <a href="/f">Follow us on socials</a> <a href="/g">Merch store</a></p>
        </div>
        <div id="content">
          <p>The summer concert series returns to the riverside stage this July with a full slate of touring acts.</p>
          <p>Doors open at six each Friday evening, music starts at seven, and admission is free for all ages.</p>
        </div>
      </div>
    </body>`);

    expect(out).toContain('summer concert series');
    expect(out).toContain('Doors open at six');
    expect(out).not.toContain('Newsletter signup');
  });

  test('a semantic tag still wins over scoring', () => {
    // Author intent outranks our heuristic, always.
    const out = md(`<body>
      <div><p>Long unrelated prose in a div that would score very well on its own merits here.</p>
      <p>More long unrelated prose that keeps this division scoring competitively high overall.</p></div>
      <main><p>The real content.</p></main>
    </body>`);
    expect(out).toBe('The real content.');
  });

  test('no clear winner falls back to the whole body', () => {
    // Text spread evenly across parents = no main region to claim. Losing
    // content on a wrong guess is worse than including everything.
    const out = md(`<body>
      <div><p>First section of prose, long enough to score as a real paragraph of content.</p></div>
      <div><p>Second section of prose, long enough to score as a real paragraph of content.</p></div>
      <div><p>Third section of prose, long enough to score as a real paragraph of content.</p></div>
    </body>`);
    expect(out).toContain('First section');
    expect(out).toContain('Third section');
  });

  test('too little signal falls back to the whole body', () => {
    const out = md('<body><div><p>Only one real paragraph of content lives anywhere on this page.</p></div><div><span>stray</span></div></body>');
    expect(out).toContain('Only one real paragraph');
    expect(out).toContain('stray');
  });
});

describe('READABILITY-CHROME-1 — scoring must ignore page furniture', () => {
  test('a prose-heavy sidebar never wins the vote', () => {
    // The aside carries MORE prose than the content div. Scoring that ignores
    // chrome hands back the sidebar as the page's main content.
    const out = md(`<body>
      <aside>
        <p>Our venue has served the riverside district since nineteen seventy two, hosting weddings and civic functions throughout the year.</p>
        <p>Sign up to the mailing list for occasional updates about upcoming shows, volunteer opportunities and seasonal closures.</p>
      </aside>
      <div id="content">
        <p>The summer concert series runs every Friday evening in July.</p>
      </div>
    </body>`);

    expect(out).toContain('summer concert series');
    expect(out).not.toContain('nineteen seventy two');
    expect(out).not.toContain('mailing list');
  });

  test('a prose-heavy nav never wins the vote', () => {
    const out = md(`<body>
      <nav>
        <p>Browse concerts, browse theatre, browse comedy, browse family shows and browse seasonal events here.</p>
        <p>Accessibility information, parking information, ticketing information and contact information all live here.</p>
      </nav>
      <div><p>Doors open at six on Friday.</p></div>
    </body>`);

    expect(out).toContain('Doors open at six');
    expect(out).not.toContain('Browse concerts');
  });
});

describe('MARKDOWN-DATAURI-1 — inline data URIs must not reach the guard', () => {
  // Found on a live site by scripts/parity-check.mjs. A 1x1 base64 PNG is the
  // standard lazy-loading placeholder, and emitting it as an image src tripped
  // the prompt-injection guard's encoded-payload rule — quarantining a
  // perfectly ordinary page. Plain text never hit this because images are not
  // in text; the markdown converter introduced it.
  const PLACEHOLDER =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAQAAAA3fa6RAAAADklEQVR42mNkAANGCAUAACMAA2w/AMgAAAAASUVORK5CYII=';

  test('a base64 placeholder src is not emitted', () => {
    const out = md(`<main><p>Concerts on Friday.</p><img src="${PLACEHOLDER}" alt=""></main>`);
    expect(out).not.toContain('base64');
    expect(out).not.toContain('data:image');
  });

  test('alt text survives even when the src is dropped', () => {
    // The alt is often the only description of the image, so losing it would
    // trade one bug for another.
    const out = md(`<main><img src="${PLACEHOLDER}" alt="Summer schedule poster"></main>`);
    expect(out).toContain('Summer schedule poster');
    expect(out).not.toContain('base64');
  });

  test('a real image URL is still emitted', () => {
    const out = md('<main><img src="/uploads/banner.webp" alt="Banner"></main>');
    expect(out).toContain('/uploads/banner.webp');
  });

  test('a page carrying placeholders is not quarantined', async () => {
    const { sanitizeCrawledText } = await import('@/guard/prompt-injection-guard');
    const out = md(
      `<main><img src="${PLACEHOLDER}" alt=""><p>The summer season opens on Friday with live music and a full bar.</p></main>`,
    );
    expect(sanitizeCrawledText(out, 20000).signals).toEqual([]);
  });
});
