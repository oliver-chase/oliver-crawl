// ─── Live checks: local Chromium rendering ─────────────────────────────────

import { createCrawler } from '../../dist/index.js';
import { renderViaLocalChromium } from '../../dist/fetch/local-render.js';
import { USER_AGENT, IANA, RFC, dns, check, assert, Unavailable, crawler } from './harness.mjs';

export async function renderChecks() {

  console.log('\nRendering');
  // ─── Local Chromium rendering ────────────────────────────────────────────────
  //
  // The render rung could not be exercised anywhere before this. It cannot run in
  // the unit suite: it drives a REAL browser at a REAL URL, and the host guard
  // refuses the private addresses a local test server would bind to. So the rung
  // that carries the most security machinery — navigation-hop checks, subresource
  // screening, same-site landing — had every guard tested in isolation and the
  // rung itself never driven end to end.
  //
  // Forcing it: renderWhenTextBelow set above any real page length makes every
  // fetch look thin, so the ladder escalates to render on a page that fetched fine.
  {
    let playwrightPresent = true;
    try {
      await import('playwright');
    } catch {
      playwrightPresent = false;
    }

    if (!playwrightPresent) {
      console.log('  (playwright not installed — local render checks skipped)');
    } else {
      const renderCrawler = createCrawler({
        userAgent: USER_AGENT,
        dnsLookup: dns,
        minHostIntervalMs: 500,
        localRender: true,
        renderWhenTextBelow: 10_000_000,
      });

      await check('local Chromium renders a real page', async () => {
        const r = await renderCrawler.crawl(IANA, 'https://www.iana.org/help/example-domains');
        assert(r.ok, `${r.reason}: ${r.detail}`);
        const page = r.pages[0];
        assert(page.rung === 'local-render', `escalated to ${page.rung}, not local-render`);
        assert(page.text.length > 0, 'rendered page had no text');
        return `${page.text.length} chars`;
      });

      await check('a rendered page has the same shape as a fetched one', async () => {
        // PAGE-SHAPE-1 claimed "every rung" while never driving this one. A rung
        // returning a thinner page than its neighbours shows up as worse
        // extraction and gets blamed on the site.
        const r = await renderCrawler.crawl(IANA, 'https://www.iana.org/help/example-domains');
        assert(r.ok, `${r.reason}: ${r.detail}`);
        const page = r.pages[0];
        // QA: without this the check passed on the PLAIN FETCH rung — any
        // HTML-derived rung satisfied the body, so it asserted the shape of a
        // page the render rung never produced. Same vacuous-shape defect as the
        // unit test this replaced, reintroduced in its replacement.
        assert(page.rung === 'local-render', `shape checked on ${page.rung}, not local-render`);
        assert(/^[a-f0-9]{64}$/.test(page.textSha256), 'textSha256 missing — change detection would be dead for this rung');
        assert(/^[a-f0-9]{64}$/.test(page.bodySha256), 'bodySha256 missing');
        // Rendered output IS HTML, so the HTML-derived fields must be populated
        // and not empty the way a prose rung leaves them.
        assert(/^[a-f0-9]{64}$/.test(page.contentRegionSha256), 'contentRegionSha256 empty on an HTML-derived rung');
        assert(page.markdown.length > 0, 'markdown empty on an HTML-derived rung');
        assert(Array.isArray(page.links) && Array.isArray(page.jsonLd), 'array fields not arrays');
        return `markdown ${page.markdown.length}, ${page.links.length} links`;
      });

      await check('a redirect chain leaving the site is refused BEFORE the hop', async () => {
        // RENDER-HOP-2, and the only check that can prove it. The static wiring
        // tests assert the guard is present; QA showed a guard can be present,
        // correct and never invoked. This drives a real off-site chain that
        // RETURNS HOME, which is the shape that defeated the previous fix: the
        // landing check saw the original host and passed.
        const chain =
          'https://nghttp2.org/httpbin/redirect-to?url=' +
          encodeURIComponent('https://httpbin.org/redirect-to?url=' + encodeURIComponent('https://nghttp2.org/httpbin/get'));
        const reasons = [];
        const html = await renderViaLocalChromium(chain, true, [], dns, (r) => reasons.push(r));
        assert(html === null, 'an off-site redirect chain rendered anyway');
        assert(reasons.length > 0, 'the refusal was silent (RENDER-SILENT-1)');
        assert(/off-domain|Blocked/i.test(reasons[0]), `refused for an unrelated reason: ${reasons[0]}`);
        return reasons[0].slice(0, 44);
      });

      await check('a same-site redirect still renders', async () => {
        // The other half. A guard that refuses the attack AND the ordinary case
        // is not a guard, it is an outage — and it would show up as the render
        // rung quietly never working.
        const same =
          'https://nghttp2.org/httpbin/redirect-to?url=' + encodeURIComponent('https://nghttp2.org/httpbin/get');
        const html = await renderViaLocalChromium(same, true, [], dns, () => {});
        assert(html !== null, 'a same-site redirect was refused');
        assert(html.length > 0, 'same-site redirect returned empty html');
        return `${html.length} chars`;
      });

      await check('the render rung reports what it did', async () => {
        // NOT a test of the refusal itself. Driving a real cross-site redirect
        // would need a redirector this suite does not control, so RENDER-HOP-1
        // and RENDER-SUBRESOURCE-1 are proven in tests/fetch/render-wiring.test.ts
        // against a stubbed browser instead.
        //
        // What this adds on top: RENDER-SILENT-1's reporting path is real. The
        // rung used to swallow every outcome into `return null`, so an operator
        // could not tell a blocked redirect from an uninstalled browser. If the
        // rung goes silent again, this goes red where a stub cannot.
        const events = [];
        const guarded = createCrawler({
          userAgent: USER_AGENT,
          dnsLookup: dns,
          minHostIntervalMs: 500,
          localRender: true,
          renderWhenTextBelow: 10_000_000,
          onUsage: (e) => events.push(e),
        });
        await guarded.crawl(
          { baseUrl: 'https://www.rfc-editor.org', robotsPolicy: 'allow', active: true },
          'https://www.rfc-editor.org/rfc/rfc9309.html',
        );
        const rendered = events.filter((e) => e.rung === 'local-render');
        assert(rendered.length > 0, 'render rung emitted no usage event at all');
        // QA: counting events alone kept this green with onBlocked unwired, since
        // the success path emits too. Name what is being proven.
        assert(rendered.some((e) => e.ok), 'no successful render event');
        return `${rendered.length} render events, ${rendered.filter((e) => e.ok).length} ok`;
      });
    }
  }
}
