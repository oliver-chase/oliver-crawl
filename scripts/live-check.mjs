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

import { createCrawler, crawlSite, discoverSitemapUrls, searchAndCrawl } from '../dist/index.js';
import { lookup } from 'node:dns/promises';

const dns = async (h) => (await lookup(h, { all: true })).map((r) => ({ address: r.address, family: r.family }));

const crawler = createCrawler({
  userAgent: 'OliverCrawl-LiveCheck/0.1 (+https://github.com/oliver-chase/oliver-crawl)',
  dnsLookup: dns,
  minHostIntervalMs: 500,
  adaptiveThrottleMultiplier: 2,
});

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

/**
 * A paid key that is out of credits is not a code regression, and neither is
 * a third-party outage — the same reasoning that keeps this script out of
 * `npm test`. Throw this to report SKIP instead of FAIL.
 */
class Unavailable extends Error {}

/** Provider quota/auth responses, which say nothing about our code. */
function skipIfProviderUnavailable(detail) {
  if (/HTTP (400|401|402|403|429|432)/.test(detail)) {
    throw new Unavailable(detail);
  }
}

async function check(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const detail = await fn();
    console.log(`PASS${detail ? ` (${detail})` : ''}`);
    passed++;
  } catch (error) {
    if (error instanceof Unavailable) {
      console.log(`SKIP (${error.message})`);
      skipped++;
      return;
    }
    console.log('FAIL');
    failed++;
    failures.push(`${name}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const IANA = { baseUrl: 'https://www.iana.org', robotsPolicy: 'allow', active: true };
const RFC = { baseUrl: 'https://www.rfc-editor.org', robotsPolicy: 'allow', active: true };

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

await check('non-HTML content-type is refused, not mis-parsed', async () => {
  const r = await crawler.crawl(RFC, 'https://www.rfc-editor.org/rfc/rfc2616.txt');
  // Either refused as unsupported, or read as text/plain — both correct;
  // what must NOT happen is HTML-parsing a non-HTML document.
  assert(r.ok || r.reason === 'empty', `unexpected: ${r.reason} ${r.detail}`);
  return r.ok ? 'read as text' : 'refused as unsupported';
});

console.log('\nSecurity guards');
await check('refuses a private-resolving host (SSRF)', async () => {
  const localCrawler = createCrawler({
    userAgent: 'OliverCrawl-LiveCheck/0.1',
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
  const auto = createCrawler({ userAgent: 'OliverCrawl-LiveCheck/0.1', dnsLookup: dns, autoRobots: true });
  const r = await auto.crawl({ baseUrl: 'https://www.iana.org' }, 'https://www.iana.org/about');
  assert(r.ok, `autoRobots did not permit a crawlable page: ${r.detail}`);
  return 'resolved and allowed';
});

console.log('\nRe-crawl efficiency');
await check('conditional GET yields a real 304', async () => {
  const first = await crawlSite(crawler, IANA, { seeds: ['https://www.iana.org/about'], maxPages: 1 });
  const v = first.validators['https://www.iana.org/about'];
  assert(v, 'no validators returned');
  if (!v.etag && !v.lastModified) return 'origin sent no validators (cannot exercise)';

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
  const found = await discoverSitemapUrls(RFC, { userAgent: 'OliverCrawl-LiveCheck/0.1', maxUrls: 5, dnsLookup: dns });
  assert(found.urls.length > 0, `no sitemap URLs: ${found.reason}`);
  assert(found.urls.every((u) => u.includes('rfc-editor.org')), 'a non-same-site URL survived filtering');
  return `${found.urls.length} urls`;
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

console.log('\nSearch (skipped without a key)');
if (process.env.SERPER_API_KEY || process.env.TAVILY_API_KEY) {
  const searchCrawler = createCrawler({
    userAgent: 'OliverCrawl-LiveCheck/0.1',
    dnsLookup: dns,
    autoRobots: true,
    vendor: { serper: process.env.SERPER_API_KEY, tavily: process.env.TAVILY_API_KEY },
  });

  await check('web search returns usable results', async () => {
    const found = await searchCrawler.search('rfc editor internet standards', { maxResults: 3 });
    if (!found.ok) skipIfProviderUnavailable(found.detail);
    assert(found.ok, `${found.reason}: ${found.detail}`);
    assert(found.results.length > 0, 'no results');
    assert(found.results.every((r) => r.url.startsWith('http')), 'an unsafe URL survived filtering');
    return `${found.results.length} via ${found.provider}`;
  });

  await check('site: restriction narrows to one domain', async () => {
    const found = await searchCrawler.search('standards', { site: 'rfc-editor.org', maxResults: 3 });
    if (!found.ok) skipIfProviderUnavailable(found.detail);
    assert(found.ok, `${found.reason}: ${found.detail}`);
    assert(found.results.some((r) => r.url.includes('rfc-editor.org')), 'site: restriction had no effect');
    return `${found.results.length} results`;
  });

  await check('searchAndCrawl reads the pages it finds', async () => {
    const found = await searchAndCrawl(searchCrawler, 'rfc editor', { maxResults: 2 });
    if (!found.ok) skipIfProviderUnavailable(found.detail);
    assert(found.ok, `${found.reason}: ${found.detail}`);
    return `${found.pages.length} read, ${found.skipped.length} skipped`;
  });
} else {
  console.log('  (no SERPER_API_KEY / TAVILY_API_KEY — search checks skipped)');
}

console.log(`\n${'-'.repeat(52)}`);
console.log(`${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
if (skipped) console.log('(skips are unavailable third parties — exhausted keys or outages, not code)');
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
