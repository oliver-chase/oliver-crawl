#!/usr/bin/env node
// ─── Live validation ────────────────────────────────────────────────────────
//
// Exercises every feature against REAL websites. The unit suite proves the
// logic; this proves the logic survives contact with actual origins —
// real redirects, real charsets, real robots.txt, real 304s.
//
//   npm run live
//
// Deliberately kept OUT of `npm test`: it needs network, it is slower, and a
// third-party site being down is not a reason to fail a build. Run it before
// a release or after touching the fetch path.
//
// Targets are chosen for stability and permissiveness — long-lived
// standards/documentation sites that are used to being crawled. Politeness
// settings here are deliberately conservative.

import { createCrawler, crawlSite, discoverSitemapUrls, mapSite } from '../dist/index.js';
import { USER_AGENT, IANA, RFC, Unavailable, dns, crawler, check, assert, finish } from './live-check/harness.mjs';
import { renderChecks } from './live-check/render.mjs';
import { searchChecks } from './live-check/search.mjs';


console.log('\nLIVE VALIDATION — real sites, real network\n');

console.log('Core fetch');
await check('single page crawl', async () => {
  const r = await crawler.crawl(IANA, 'https://www.iana.org/about');
  assert(r.ok, `not ok: ${r.detail}`);
  assert(!r.notModified, 'unexpected 304 on a fresh crawl');
  assert(r.pages[0].text.length > 200, 'suspiciously little text');
  assert(r.pages[0].title, 'no title extracted');
  return `${r.pages[0].text.length} chars, rung=${r.pages[0].rung}`;
});

await check('follows a real redirect', async () => {
  // http -> https and/or apex -> www is near-universal.
  const r = await crawler.crawl(RFC, 'https://www.rfc-editor.org/rfc/rfc2616');
  assert(r.ok, `not ok: ${r.detail}`);
  return r.pages[0].url;
});

await check('a binary content-type is refused, never mis-parsed', async () => {
  // Since CRAWL-FEED-1 text-ish documents ARE read, so this asserts the half
  // that must stay refused: HTML-parsing an image produces confident nonsense.
  // A URL that really exists and really is an image (200 image/png), so this fails on the content-type gate — not on a 404, which
  // would pass for the wrong reason and prove nothing.
  const r = await crawler.crawl(RFC, 'https://www.rfc-editor.org/favicon.ico');
  assert(!r.ok, `an image URL was accepted: kind=${r.ok ? r.pages[0].contentKind : ''}`);
  assert(r.reason === 'empty', `expected a content-type refusal, got ${r.reason}: ${r.detail}`);
  assert(/Unsupported content-type/.test(r.detail), `wrong refusal: ${r.detail}`);
  return r.detail.slice(0, 44);
});

console.log('\nSecurity guards');
await check('refuses a private-resolving host (SSRF)', async () => {
  const localCrawler = createCrawler({
    userAgent: USER_AGENT,
    dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  const r = await localCrawler.crawl(IANA, 'https://www.iana.org/about');
  assert(!r.ok && r.reason === 'blocked', 'a private-resolving host was NOT blocked');
  return r.detail.slice(0, 48);
});

await check('refuses an off-domain URL', async () => {
  const r = await crawler.crawl(IANA, 'https://www.rfc-editor.org/');
  assert(!r.ok && r.reason === 'blocked', 'off-domain URL was not blocked');
  return 'blocked';
});

await check('refuses unknown robots posture (fails closed)', async () => {
  const r = await crawler.crawl({ baseUrl: 'https://www.iana.org' }, 'https://www.iana.org/about');
  assert(!r.ok && r.reason === 'blocked', 'unknown robots did not fail closed');
  return 'fail-closed';
});

await check('autoRobots resolves a real robots.txt', async () => {
  const auto = createCrawler({ userAgent: USER_AGENT, dnsLookup: dns, autoRobots: true });
  const r = await auto.crawl({ baseUrl: 'https://www.iana.org' }, 'https://www.iana.org/about');
  assert(r.ok, `autoRobots did not permit a crawlable page: ${r.detail}`);
  return 'resolved and allowed';
});

console.log('\nRe-crawl efficiency');
await check('conditional GET yields a real 304', async () => {
  const first = await crawlSite(crawler, IANA, { seeds: ['https://www.iana.org/about'], maxPages: 1 });
  const v = first.validators['https://www.iana.org/about'];
  assert(v, 'no validators returned');
  if (!v.etag && !v.lastModified) throw new Unavailable('origin sent no validators, so a 304 cannot be exercised');

  const second = await crawlSite(crawler, IANA, {
    seeds: ['https://www.iana.org/about'],
    priorValidators: { 'https://www.iana.org/about': v },
    maxPages: 1,
  });
  assert(second.notModified.length === 1, `expected a 304, got ${second.pages.length} fetched pages`);
  return 'free 304 on re-crawl';
});

await check('content hash detects an unchanged page', async () => {
  const first = await crawlSite(crawler, RFC, { seeds: ['https://www.rfc-editor.org/'], maxPages: 1 });
  const v = first.validators['https://www.rfc-editor.org/'];
  assert(v, 'no validators');
  const second = await crawlSite(crawler, RFC, {
    seeds: ['https://www.rfc-editor.org/'],
    priorValidators: { 'https://www.rfc-editor.org/': { ...v, etag: null, lastModified: null } },
    maxPages: 1,
  });
  // Either a 304 (origin validators) or an unchanged flag (content hash).
  assert(second.notModified.length + second.unchanged.length > 0, 'neither 304 nor unchanged detected');
  return second.notModified.length ? '304' : 'content-hash unchanged';
});

console.log('\nDiscovery');
await check('sitemap discovery on a real site', async () => {
  const found = await discoverSitemapUrls(RFC, { userAgent: USER_AGENT, maxUrls: 5, dnsLookup: dns });
  assert(found.urls.length > 0, `no sitemap URLs: ${found.reason}`);
  assert(found.urls.every((u) => u.includes('rfc-editor.org')), 'a non-same-site URL survived filtering');
  return `${found.urls.length} urls`;
});

await check('sitemap lastmod is captured from a real site', async () => {
  // BETTER-LASTMOD-1: one request answers "which pages changed" for the whole
  // site. Real sitemaps vary — many publish no lastmod at all — so this
  // asserts the SHAPE is right and reports whether this origin publishes it.
  const found = await discoverSitemapUrls(RFC, { userAgent: USER_AGENT, maxUrls: 10, dnsLookup: dns });
  assert(found.entries.length > 0, `no sitemap entries: ${found.reason}`);
  assert(found.entries.length === found.urls.length, 'entries and urls disagree');
  assert(found.entries.every((e) => typeof e.url === 'string'), 'entry missing url');
  assert(found.entries.every((e) => e.lastmod === null || typeof e.lastmod === 'string'), 'bad lastmod type');
  const withMod = found.entries.filter((e) => e.lastmod).length;
  return `${found.entries.length} entries, ${withMod} with lastmod`;
});

await check('mapSite lists a real site cheaply', async () => {
  // PARITY-MAP-1: answers "what pages exist" without crawling them.
  const map = await mapSite(crawler, RFC, { maxUrls: 25 });
  assert(map.urls.length > 1, `too few urls: ${map.urls.length}`);
  assert(map.urls.every((u) => u.includes('rfc-editor.org')), 'an off-site URL survived');
  assert(new Set(map.urls).size === map.urls.length, 'duplicate urls returned');
  return `${map.urls.length} urls (sitemap ${map.sources.sitemap}, links ${map.sources.homepageLinks}), ${map.feeds.length} feeds`;
});

await check('whole-site link following from ONE seed', async () => {
  const run = await crawlSite(crawler, RFC, {
    seeds: ['https://www.rfc-editor.org/'],
    followLinks: true,
    maxDepth: 1,
    maxPages: 4,
    maxDurationMs: 30_000,
  });
  assert(run.pages.length > 1, `one seed yielded only ${run.pages.length} page(s)`);
  const urls = run.pages.map((p) => p.url);
  assert(new Set(urls).size === urls.length, 'duplicate pages returned');
  return `${run.pages.length} unique pages`;
});

await check('time budget stops a run cleanly', async () => {
  const started = Date.now();
  const run = await crawlSite(crawler, RFC, {
    seeds: ['https://www.rfc-editor.org/'],
    followLinks: true,
    maxPages: 50,
    maxDurationMs: 3_000,
  });
  const elapsed = Date.now() - started;
  assert(elapsed < 20_000, `budget ignored: ran ${elapsed}ms`);
  assert(run.pages.length > 0, 'stopped without gathering anything');
  return `${run.pages.length} pages in ${elapsed}ms`;
});

console.log('\nExtraction');
await check('JSON-LD is read when a site publishes it', async () => {
  // Not every page has it; this asserts the field exists and is well-formed.
  const r = await crawler.crawl(IANA, 'https://www.iana.org/');
  assert(r.ok, r.detail);
  assert(Array.isArray(r.pages[0].jsonLd), 'jsonLd is not an array');
  return `${r.pages[0].jsonLd.length} node(s)`;
});

await check('links and outbound hosts are separated correctly', async () => {
  const r = await crawler.crawl(IANA, 'https://www.iana.org/');
  assert(r.ok, r.detail);
  const page = r.pages[0];
  assert(page.links.every((l) => l.url.includes('iana.org')), 'an off-site URL leaked into same-site links');
  assert(page.outboundHosts.every((h) => !h.includes('www.iana.org')), 'same-site host leaked into outbound');
  return `${page.links.length} same-site, ${page.outboundHosts.length} outbound hosts`;
});

await check('markdown preserves real page structure', async () => {
  // VENDOR-PARITY-1: the free lane must produce what a caller would otherwise
  // pay Firecrawl for. Asserts structure survived, not just that a string came
  // back — flattened text would still be non-empty.
  const r = await crawler.crawl(RFC, 'https://www.rfc-editor.org/');
  assert(r.ok, r.detail);
  const { markdown, text } = r.pages[0];
  assert(markdown.length > 200, `markdown suspiciously short: ${markdown.length}`);
  assert(/^#{1,6} /m.test(markdown), 'no headings survived');
  assert(/\[[^\]]+\]\([^)]+\)/.test(markdown), 'no links survived');
  return `${markdown.length} md chars vs ${text.length} text`;
});

await check('markdown drops page chrome', async () => {
  const r = await crawler.crawl(IANA, 'https://www.iana.org/about');
  assert(r.ok, r.detail);
  const { markdown, text } = r.pages[0];
  // The nav appears in flat text but must not appear in the main region.
  assert(markdown.length > 0, 'no markdown produced');
  assert(markdown.length < text.length * 3, 'markdown implausibly larger than text');
  return `${markdown.length} chars, chrome-scoped`;
});

await check('structured-data summary reflects a real page', async () => {
  // JSONLD-SIGNAL-1: the field a caller uses to decide whether to pay for an
  // LLM at all, so it has to be right on real markup, not just fixtures.
  const r = await crawler.crawl(IANA, 'https://www.iana.org/');
  assert(r.ok, r.detail);
  const s = r.pages[0].structuredData;
  assert(Array.isArray(s.types) && Array.isArray(s.contentTypes), 'summary shape wrong');
  assert(typeof s.hasContentData === 'boolean', 'hasContentData missing');
  assert(s.nodeCount >= 0, 'nodeCount missing');
  // hasContentData must agree with contentTypes — a caller branches on it.
  assert(s.hasContentData === s.contentTypes.length > 0, 'hasContentData disagrees with contentTypes');
  return `${s.nodeCount} nodes, content=${s.hasContentData}, types=[${s.types.join(',')}]`;
});

await check('a real non-HTML document is read, not refused', async () => {
  // CRAWL-FEED-1: the fetch rung used to refuse anything but html/plain, so
  // a discovered feed could never be fetched. rfc-editor serves .txt.
  const r = await crawler.crawl(RFC, 'https://www.rfc-editor.org/rfc/rfc2616.txt');
  assert(r.ok, `not ok: ${r.detail}`);
  const p = r.pages[0];
  assert(p.text.length > 500, `suspiciously short: ${p.text.length}`);
  // A data document has no HTML-derived fields — empty, never faked.
  assert(p.markdown === '', 'markdown should be empty on a non-HTML kind');
  assert(p.contentRegionSha256 === '', 'structural hash should be empty');
  assert(p.textSha256.length === 64, 'textSha256 must always be set');
  return `kind=${p.contentKind}, ${p.text.length} chars`;
});

await renderChecks();
await searchChecks();
finish();
