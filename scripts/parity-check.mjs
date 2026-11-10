#!/usr/bin/env node
// ─── Extraction parity harness ──────────────────────────────────────────────
//
// CRAWL-PARITY-1. Before any consumer replaces its own extractor with this
// library, somebody has to demonstrate the two agree. The migration assumed
// parity and never measured it.
//
// This matters more than an ordinary regression: a silent extraction
// difference across every source does not look like a bug. It looks like the
// data slowly getting worse, and it is attributed to the sites changing.
//
//   node scripts/parity-check.mjs urls.txt          # one URL per line
//   node scripts/parity-check.mjs urls.txt --json   # machine-readable
//
// It reports, per URL, what this library extracted. Point your existing
// extractor at the same list and diff the two reports. Deliberately NOT
// coupled to any particular consumer's extractor — this library must not
// import any consumer, or anything downstream.
//
// The output is intentionally boring: counts and hashes, not prose. Those are
// what a diff can compare without a human reading every page.

import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { createCrawler } from '../dist/index.js';

const args = process.argv.slice(2);
const listFile = args.find((a) => !a.startsWith('--'));
const asJson = args.includes('--json');

if (!listFile) {
  console.error('usage: node scripts/parity-check.mjs <urls-file> [--json]');
  process.exit(2);
}

const urls = readFileSync(listFile, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

if (urls.length === 0) {
  console.error(`${listFile} contained no URLs.`);
  process.exit(2);
}

const dns = async (h) => (await lookup(h, { all: true })).map((r) => ({ address: r.address, family: r.family }));

const crawler = createCrawler({
  userAgent: 'OliverCrawl-ParityCheck/1.0 (+https://github.com/oliver-chase/oliver-crawl)',
  dnsLookup: dns,
  autoRobots: true,
  minHostIntervalMs: 1000,
  adaptiveThrottleMultiplier: 2,
});

const rows = [];

for (const url of urls) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    rows.push({ url, ok: false, reason: 'unparseable' });
    continue;
  }

  const result = await crawler.crawl({ baseUrl: origin, name: origin }, url);

  if (!result.ok) {
    rows.push({ url, ok: false, reason: result.reason, failureClass: result.failureClass, detail: result.detail });
    continue;
  }
  if (result.notModified) {
    rows.push({ url, ok: true, notModified: true });
    continue;
  }

  const page = result.pages[0];
  rows.push({
    url,
    ok: true,
    rung: page.rung,
    contentKind: page.contentKind,
    // Lengths and counts, not content: a diff over these is readable, and a
    // diff over full page text is not.
    textChars: page.text.length,
    markdownChars: page.markdown.length,
    title: page.title,
    jsonLdNodes: page.structuredData.nodeCount,
    contentTypes: page.structuredData.contentTypes,
    hasContentData: page.structuredData.hasContentData,
    links: page.links.length,
    outboundHosts: page.outboundHosts.length,
    likelyEmptyState: page.likelyEmptyState,
    candidateImages: page.candidateContentImages.length,
    textSha256: page.textSha256,
  });
}

if (asJson) {
  console.log(JSON.stringify({ generatedFor: listFile, rows }, null, 2));
  process.exit(0);
}

const ok = rows.filter((r) => r.ok && !r.notModified);
const failed = rows.filter((r) => !r.ok);

console.log(`\nEXTRACTION PARITY — ${rows.length} URLs\n`);
for (const row of rows) {
  if (!row.ok) {
    console.log(`  FAIL  ${row.url}\n        ${row.reason} (${row.failureClass ?? 'unclassified'}) — ${row.detail ?? ''}`);
    continue;
  }
  if (row.notModified) {
    console.log(`  304   ${row.url}`);
    continue;
  }
  console.log(
    `  OK    ${row.url}\n` +
      `        rung=${row.rung} kind=${row.contentKind} text=${row.textChars} md=${row.markdownChars}\n` +
      `        jsonLd=${row.jsonLdNodes} content=${row.hasContentData} [${row.contentTypes.join(',')}]\n` +
      `        links=${row.links} images=${row.candidateImages} empty=${row.likelyEmptyState}`,
  );
}

console.log(`\n${'-'.repeat(56)}`);
console.log(`${ok.length} extracted, ${failed.length} failed`);

// Aggregate signals worth eyeballing before a swap. Each is a question the
// consumer should be able to answer about their own extractor too.
if (ok.length > 0) {
  const noText = ok.filter((r) => r.textChars < 200).length;
  const noMarkdown = ok.filter((r) => r.markdownChars === 0).length;
  const structured = ok.filter((r) => r.hasContentData).length;
  const emptyState = ok.filter((r) => r.likelyEmptyState).length;
  const withImages = ok.filter((r) => r.candidateImages > 0).length;

  console.log(`\n  ${structured}/${ok.length} publish usable structured data — these need no model at all`);
  console.log(`  ${noText} returned under 200 chars of text`);
  console.log(`  ${noMarkdown} produced no markdown (non-HTML rung, or no main content found)`);
  console.log(`  ${emptyState} look like empty states`);
  console.log(`  ${withImages} carry a candidate content image`);
}

console.log('\nCompare against your existing extractor on the SAME list.');
console.log('Explain every disagreement before switching anything over.\n');
