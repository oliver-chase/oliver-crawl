import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildPage, isQuarantined } from '@/fetch/build-page';
import type { CrawlPage } from '@/core/types';

// Extraction is scored against a fixed set of saved pages, so an accuracy change
// shows up as a number in `npm run check` and a regression fails it. Each fixture is `name.html`
// plus `name.expect.json`: the title, the text that must reach the markdown, the page furniture that
// must stay out of it, and the links that must be found. Add a page whenever a real one is extracted
// wrongly. Raise the baseline with UPDATE_ACCURACY_BASELINE=1 after an intended improvement.

const dir = join(__dirname, 'corpus');
const baselinePath = join(__dirname, 'baseline.json');
const MARGIN = 0.005;

type Expect = { title: string; include: string[]; exclude: string[]; links: string[] };
type Scores = { recall: number; noise: number; links: number; title: number; page: number };

const squash = (text: string) => text.replace(/\s+/g, ' ').toLowerCase();

async function extract(name: string): Promise<CrawlPage> {
  const page = await buildPage({
    url: `https://corpus.example.com/${name}`,
    html: readFileSync(join(dir, `${name}.html`), 'utf8'),
    contentType: 'text/html',
    etag: null,
    lastModified: null,
    baseHost: 'corpus.example.com',
    maxTextChars: 200_000,
    rung: 'fetch',
    includeHtml: false,
    maxLinks: 200,
    maxOutboundHosts: 25,
  });
  if (isQuarantined(page)) throw new Error(`${name} was quarantined`);
  return page;
}

function score(page: CrawlPage, want: Expect): Scores {
  const body = squash(page.markdown || page.text);
  const has = (needle: string) => body.includes(squash(needle));
  const share = (hits: number, total: number) => (total === 0 ? 1 : hits / total);
  const urls = page.links.map((link) => new URL(link.url).pathname + new URL(link.url).search);
  const recall = share(want.include.filter(has).length, want.include.length);
  const noise = share(want.exclude.filter((needle) => !has(needle)).length, want.exclude.length);
  const links = share(want.links.filter((link) => urls.includes(link)).length, want.links.length);
  const title = page.title === want.title ? 1 : 0;
  return { recall, noise, links, title, page: (recall + noise + links + title) / 4 };
}

const names = readdirSync(dir)
  .filter((file) => file.endsWith('.html'))
  .map((file) => file.replace(/\.html$/, ''))
  .sort();

describe('extraction accuracy on the fixed corpus', () => {
  test('scores no lower than the committed baseline', async () => {
    const scores: Record<string, Scores> = {};
    for (const name of names) {
      const want = JSON.parse(readFileSync(join(dir, `${name}.expect.json`), 'utf8')) as Expect;
      scores[name] = score(await extract(name), want);
    }
    const overall = Object.values(scores).reduce((sum, s) => sum + s.page, 0) / names.length;

    const rows = names.map((n) => {
      const s = scores[n]!;
      return `${n.padEnd(22)} recall ${s.recall.toFixed(2)}  noise ${s.noise.toFixed(2)}  links ${s.links.toFixed(2)}  title ${s.title}  page ${s.page.toFixed(3)}`;
    });
    console.log(`\nACCURACY ${overall.toFixed(3)} over ${names.length} pages\n${rows.join('\n')}`);

    if (process.env.UPDATE_ACCURACY_BASELINE === '1') {
      const pages = Object.fromEntries(names.map((n) => [n, Number(scores[n]!.page.toFixed(3))]));
      writeFileSync(baselinePath, JSON.stringify({ overall: Number(overall.toFixed(3)), pages }, null, 2) + '\n');
      return;
    }

    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as { overall: number; pages: Record<string, number> };
    const missing = names.filter((n) => baseline.pages[n] === undefined);
    expect(missing, `pages with no baseline score; run with UPDATE_ACCURACY_BASELINE=1: ${missing.join(', ')}`).toEqual([]);
    const regressed = names.filter((n) => scores[n]!.page < baseline.pages[n]! - MARGIN);
    expect(regressed, `pages that scored lower than their baseline: ${regressed.join(', ')}`).toEqual([]);
    expect(overall).toBeGreaterThanOrEqual(baseline.overall - MARGIN);
  });
});
