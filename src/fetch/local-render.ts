// ─── Local Chromium render rung (free) ──────────────────────────────────────
//
// Renders a JS-only page with a LOCAL headless Chromium — no service, no vendor,
// no per-call cost. Once a machine has run `npx playwright install chromium`, the
// whole render story is free; the remote service and vendor lane become fallbacks
// for environments that cannot run a browser.
//
// Three guards, and failing any of them no-ops to null so the crawl continues to
// the remote render service, then Jina: a real Node runtime (workerd cannot spawn
// Chromium), an explicit `localRender: true` so a consumer deploying to both a
// laptop and a worker chooses where rendering happens instead of finding out by
// crash, and playwright actually importing — it is NOT a dependency here.
//
// THE IMPORT TRICK: a plain `import('playwright')`, even computed as
// ['play','wright'].join(''), gets constant-folded by bundler tracers (@vercel/nft,
// esbuild, webpack), which then try to resolve playwright's optional deps and break
// the build of any consumer bundling for serverless. That pinned production three
// days stale in the origin repo (DEPLOY-BLOCKER-1). A Function-constructor import
// is invisible to every tracer — resolved at real runtime, only past guards 1-2.

import { assertHostResolvesToPublicAddress, assertRedirectUrlAllowedForHost } from './host-policy.js';
import type { DnsLookupFn } from '../core/types.js';

const RENDER_TIMEOUT_MS = 20_000;

function hasNodeRuntime(): boolean {
  return typeof process !== 'undefined' && process.versions?.node != null;
}

async function importPlaywright(): Promise<{ chromium: unknown } | null> {
  try {
    const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<{ chromium?: unknown }>;
    const mod = await dynamicImport('playwright');
    return mod && mod.chromium ? { chromium: mod.chromium } : null;
  } catch {
    return null;
  }
}

type ChromiumLike = {
  launch: (opts: { headless: boolean }) => Promise<{
    newPage: () => Promise<RenderPage>;
    close: () => Promise<void>;
  }>;
};

type RenderRoute = {
  request: () => { url: () => string; isNavigationRequest: () => boolean };
  abort: () => Promise<unknown>;
  continue: () => Promise<unknown>;
};

type RenderPage = {
  goto: (u: string, o: { waitUntil: string; timeout: number }) => Promise<unknown>;
  route: (pattern: string, handler: (route: RenderRoute) => unknown) => Promise<unknown>;
  content: () => Promise<string>;
  url: () => string;
  click: (selector: string, o: { timeout: number }) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<unknown>;
  evaluate: (fn: string) => Promise<unknown>;
};

/**
 * PARITY-ACTIONS-1: steps to run before the page is captured.
 *
 * The case this exists for is a "Load more" button or an infinite-scroll
 * listing, where the first render genuinely does not contain the content and
 * the render rung otherwise returns a page that is technically correct and
 * practically empty.
 *
 * These instructions drive a real browser we control, so they are bounded on
 * purpose — see runActions for what is enforced and why.
 */
export type BrowserAction =
  | { type: 'click'; selector: string }
  | { type: 'scroll'; times?: number }
  | { type: 'wait'; ms: number };

/** Hard ceilings. A caller cannot raise these. */
export const MAX_ACTIONS = 10;
export const MAX_ACTION_TOTAL_MS = 20_000;
const MAX_SINGLE_WAIT_MS = 5_000;
const ACTION_STEP_TIMEOUT_MS = 5_000;

/** Exported for tests: the security-relevant logic is here, and the
 *  playwright import seam is deliberately invisible to bundlers, so this
 *  cannot be reached by mocking the module. */
export async function runActions(page: RenderPage, actions: BrowserAction[], origin: string): Promise<void> {
  const deadline = Date.now() + MAX_ACTION_TOTAL_MS;

  for (const action of actions.slice(0, MAX_ACTIONS)) {
    if (Date.now() >= deadline) return;

    try {
      if (action.type === 'click') {
        await page.click(action.selector, { timeout: ACTION_STEP_TIMEOUT_MS });
      } else if (action.type === 'scroll') {
        const times = Math.min(Math.max(1, action.times ?? 1), 10);
        for (let i = 0; i < times; i++) {
          if (Date.now() >= deadline) return;
          await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
          await page.waitForTimeout(500);
        }
      } else {
        await page.waitForTimeout(Math.min(Math.max(0, action.ms), MAX_SINGLE_WAIT_MS));
      }
    } catch {
      // A missing selector usually means the list is fully loaded already.
      continue;
    }

    // A click can navigate. If it left the origin, stop before running
    // anything else against a page we did not vet.
    try {
      if (new URL(page.url()).origin !== origin) return;
    } catch {
      return;
    }
  }
}

/**
 * RENDER-REDIRECT-1: where did the browser actually land?
 *
 * `page.goto` follows the entire redirect chain inside Chromium, and nothing
 * downstream re-checks the destination — the caller builds the page with the
 * URL it ASKED for. An origin could therefore bounce this rung to any host,
 * including a private address, and have the content returned under the
 * original URL. The direct-fetch rung re-validates every hop; this one did
 * not, while the README claimed the check repeats after each redirect.
 *
 * Exported for tests: playwright's import is deliberately invisible to
 * bundlers, so the surrounding function cannot be mocked.
 */
export async function assertLandedSameSite(
  finalUrl: string,
  requestedUrl: string,
  dnsLookup?: DnsLookupFn,
): Promise<void> {
  const requested = new URL(requestedUrl);
  // Delegate to the SAME guard every other rung uses rather than comparing
  // hostnames here. The first version of this compared hostname only, and QA
  // proved three live bypasses it missed: cross-port (a 302 from
  // host:A to host:B returned an internal admin service), https-to-http
  // downgrade, and a credentialed landing URL. All three are already refused
  // by assertRedirectUrlAllowedForHost, which is why nothing should
  // re-implement it.
  assertRedirectUrlAllowedForHost(requested.hostname, requested.port || '', finalUrl);
  // Then the resolution check: a same-named host can still resolve somewhere
  // private between the policy check and the browser's own lookup.
  await assertHostResolvesToPublicAddress(new URL(finalUrl).hostname, dnsLookup);
}

/**
 * Render a URL with local headless Chromium and return the post-JS HTML, or
 * null when the rung cannot run (wrong runtime, not opted in, playwright
 * absent) or the render failed.
 *
 * Null is not always silent: a refusal on SECURITY grounds calls `onBlocked`,
 * because an active redirect attack must not look like a missing browser.
 *
 * Returns HTML rather than extracted text so the caller feeds it through the
 * SAME buildPage path as every other rung — one parser, one guard, one shape.
 */
export async function renderViaLocalChromium(
  url: string,
  enabled: boolean,
  actions: BrowserAction[] = [],
  dnsLookup?: DnsLookupFn,
  /**
   * RENDER-SILENT-1: called when the rung refused for a SECURITY reason rather
   * than being unavailable. Without it, `catch { return null }` made an active
   * redirect attack indistinguishable from "playwright is not installed" — the
   * one failure an operator most needs to see looked like the most routine one.
   */
  onBlocked?: (reason: string) => void,
): Promise<string | null> {
  if (!enabled || !url || !hasNodeRuntime()) return null;
  const pw = await importPlaywright();
  if (!pw) return null;

  const chromium = pw.chromium as ChromiumLike;
  let browser: Awaited<ReturnType<ChromiumLike['launch']>> | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    // RENDER-HOP-1: validate every NAVIGATION hop, not just where the chain
    // ended. Checking only the landing let `site -> 127.0.0.1:P -> site` render
    // normally while the private server received a real request — the request
    // itself is the leak, and a chain that returns home hides it completely.
    // The direct-fetch rung validates each hop; this brings the render rung to
    // the same standard.
    const blockedHops: string[] = [];
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (!request.isNavigationRequest()) {
        // RENDER-SUBRESOURCE-1: a page's own JavaScript can fetch a
        // CORS-permissive service on a private address and land the response
        // body in the DOM, which then leaves in `page.content()`. The
        // navigation guard never saw those requests.
        //
        // Only the private-address check applies here, NOT same-site: real
        // pages legitimately load images, fonts and scripts from public CDNs,
        // and refusing those would break ordinary rendering. What is refused
        // is a subresource pointed at an address the crawler may not reach.
        try {
          await assertHostResolvesToPublicAddress(new URL(request.url()).hostname, dnsLookup);
          await route.continue();
        } catch {
          // Not fatal to the render — a blocked tracker or internal beacon
          // should not lose the page. The request simply never happens.
          await route.abort();
        }
        return;
      }
      try {
        // Same guard as the landing check, applied before the hop is made.
        await assertLandedSameSite(request.url(), url, dnsLookup);
        await route.continue();
      } catch (error) {
        blockedHops.push(`${request.url()}: ${error instanceof Error ? error.message : String(error)}`);
        await route.abort();
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
    if (blockedHops.length > 0) throw new Error(`Render blocked a redirect hop — ${blockedHops[0]}`);
    // RENDER-REDIRECT-1: the browser followed the chain; check where it ended.
    await assertLandedSameSite(page.url(), url, dnsLookup);
    if (actions.length > 0) await runActions(page, actions, new URL(url).origin);
    // Actions can navigate too, so the check repeats after they run.
    await assertLandedSameSite(page.url(), url, dnsLookup);
    if (blockedHops.length > 0) throw new Error(`Render blocked a redirect hop — ${blockedHops[0]}`);
    const html = await page.content();
    return html && html.length > 0 ? html : null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Only security refusals are reported. A missing browser, a timeout or a
    // dead render service are ordinary and already visible as a skipped rung.
    if (/Blocked|redirect hop|off-domain|cross-port|credential/i.test(reason)) onBlocked?.(reason);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
