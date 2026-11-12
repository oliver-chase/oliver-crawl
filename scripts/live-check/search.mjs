// ─── Live checks: web search ───────────────────────────────────────────────

import { configFromEnv, createCrawler, searchAndCrawl } from '../../dist/index.js';
import { USER_AGENT, dns, check, assert, skipIfProviderUnavailable } from './harness.mjs';

export async function searchChecks() {
  console.log('\nSearch (skipped without a key)');
  // Reads the keys the way the library does, OLIVERCRAWL_* first and the bare names second.
  const { vendor } = configFromEnv(process.env);
  if (vendor?.serper || vendor?.tavily) {
    const searchCrawler = createCrawler({
      userAgent: USER_AGENT,
      dnsLookup: dns,
      autoRobots: true,
      vendor: { serper: vendor.serper, tavily: vendor.tavily },
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
    console.log('  (no OLIVERCRAWL_SERPER_KEY or OLIVERCRAWL_TAVILY_KEY (the bare names are read too) — search checks skipped)');
  }
}
