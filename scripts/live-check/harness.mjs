// ─── Shared parts of the live check ────────────────────────────────────────
//
// The crawler, the resolver, the pass/fail bookkeeping and the summary that every live check file uses.

import { createCrawler } from '../../dist/index.js';
import { lookup } from 'node:dns/promises';

export const dns = async (h) => (await lookup(h, { all: true })).map((r) => ({ address: r.address, family: r.family }));

export const USER_AGENT = 'LiveCheck/1.0 (+https://example.com/bot)';

export const crawler = createCrawler({
  userAgent: USER_AGENT,
  dnsLookup: dns,
  minHostIntervalMs: 500,
  adaptiveThrottleMultiplier: 2,
});

export const IANA = { baseUrl: 'https://www.iana.org', robotsPolicy: 'allow', active: true };
export const RFC = { baseUrl: 'https://www.rfc-editor.org', robotsPolicy: 'allow', active: true };

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

/**
 * A paid key that is out of credits is not a code regression, and neither is
 * a third-party outage — the same reasoning that keeps this script out of
 * `npm test`. Throw this to report SKIP instead of FAIL.
 */
export class Unavailable extends Error {}

/** Provider quota/auth responses, which say nothing about our code. */
export function skipIfProviderUnavailable(detail) {
  if (/HTTP (400|401|402|403|429|432)/.test(detail)) {
    throw new Unavailable(detail);
  }
}

export async function check(name, fn) {
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

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Prints the totals and exits non-zero when anything failed. */
export function finish() {

console.log(`\n${'-'.repeat(52)}`);
console.log(`${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
if (skipped) console.log('(skips are unavailable third parties — exhausted keys or outages, not code)');
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
}

