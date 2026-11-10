import { describe, expect, test } from 'vitest';
import { extractMainContentText, computeContentRegionHash } from '@/extract/content-region-hash';

describe('extractMainContentText', () => {
  test('prefers a <main> block when present, excluding surrounding nav/footer', () => {
    const html = `
      <html><body>
        <header>Site Header</header>
        <nav>Home | Events | Contact</nav>
        <main><h1>Summer Concert</h1><p>Doors at 7pm</p></main>
        <footer>&copy; 2026 Venue Inc.</footer>
      </body></html>`;
    const text = extractMainContentText(html);
    expect(text).toContain('Summer Concert');
    expect(text).toContain('Doors at 7pm');
    expect(text).not.toContain('Site Header');
    expect(text).not.toContain('Home | Events | Contact');
    expect(text).not.toContain('Venue Inc');
  });

  test('falls back to <article> when there is no <main>', () => {
    const html = '<body><nav>Nav</nav><article>The real event content</article><footer>Footer</footer></body>';
    const text = extractMainContentText(html);
    expect(text).toBe('The real event content');
  });

  // The concrete AC: a footer-only (or nav-only) change must not change the
  // content-region hash.
  test('a footer-only change does not change the extracted text (the actual AC)', () => {
    const base = (year: string) => `<body><nav>Menu</nav><main>Event details here</main><footer>&copy; ${year} Venue</footer></body>`;
    expect(extractMainContentText(base('2026'))).toBe(extractMainContentText(base('2027')));
  });

  test('a nav-only change does not change the extracted text either', () => {
    const base = (label: string) => `<body><nav>${label}</nav><main>Event details here</main><footer>copyright</footer></body>`;
    expect(extractMainContentText(base('Home | Events'))).toBe(extractMainContentText(base('Home | Events | New Tab')));
  });

  test('a real change WITHIN <main> does change the extracted text', () => {
    const html1 = '<body><main>Doors at 7pm</main></body>';
    const html2 = '<body><main>Doors at 8pm</main></body>';
    expect(extractMainContentText(html1)).not.toBe(extractMainContentText(html2));
  });

  test('no <main>/<article> at all: strips nav/header/footer/aside/script/style from the whole page', () => {
    const html = `
      <html><body>
        <nav>Nav</nav>
        <header>Header</header>
        <div class="content">Real content here</div>
        <aside>Sidebar ad</aside>
        <script>trackingPixel();</script>
        <style>.x { color: red; }</style>
        <footer>Footer</footer>
      </body></html>`;
    const text = extractMainContentText(html);
    expect(text).toContain('Real content here');
    expect(text).not.toContain('Nav');
    expect(text).not.toContain('Header');
    expect(text).not.toContain('Sidebar ad');
    expect(text).not.toContain('trackingPixel');
    expect(text).not.toContain('color: red');
    expect(text).not.toContain('Footer');
  });

  // A change ONLY inside a stripped tracking script must not change the hash
  // even with no <main> present — the whole-page hash would have caught this
  // as "changed" for nothing.
  test('a script-only change (no main/article) does not change the extracted text', () => {
    const base = (id: string) => `<body><div class="content">Real content</div><script>track("${id}")</script></body>`;
    expect(extractMainContentText(base('abc'))).toBe(extractMainContentText(base('xyz')));
  });
});

describe('computeContentRegionHash', () => {
  test('two byte-different pages with the same main content hash identically', async () => {
    const a = await computeContentRegionHash('<body><nav>v1</nav><main>Same event</main></body>');
    const b = await computeContentRegionHash('<body><nav>v2</nav><main>Same event</main></body>');
    expect(a).toBe(b);
  });

  test('genuinely different main content hashes differently', async () => {
    const a = await computeContentRegionHash('<body><main>Event A</main></body>');
    const b = await computeContentRegionHash('<body><main>Event B</main></body>');
    expect(a).not.toBe(b);
  });

  test('never throws on malformed/empty HTML', async () => {
    await expect(computeContentRegionHash('')).resolves.toEqual(expect.any(String));
    await expect(computeContentRegionHash('<main>unclosed')).resolves.toEqual(expect.any(String));
  });
});
