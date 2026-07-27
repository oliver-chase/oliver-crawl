// ─── Local Chromium render rung (free) ──────────────────────────────────────
//
// Renders a JS-only page with a LOCAL headless Chromium — no service, no
// vendor, no per-call cost. On any machine that has run
// `npx playwright install chromium` once, this makes the whole render story
// free; the remote render service and the vendor lane become fallbacks for
// environments that can't run a browser (serverless/edge).
//
// Three guards, all of which must pass or it no-ops to null (the crawl then
// tries the remote render service, then Jina, exactly as before):
//   1. A real Node runtime — workerd/edge cannot spawn Chromium.
//   2. `localRender: true` in config — an explicit opt-in, so a consumer
//      that deploys the same code to a laptop AND a worker chooses where
//      rendering happens instead of discovering it by crash.
//   3. `playwright` must actually import. It is NOT a dependency of this
//      package — see the Function-constructor import below.
//
// THE IMPORT TRICK (inherited from the origin repo, which learned it the
// hard way): a plain `import('playwright')` — even computed like
// ['play','wright'].join('') — is constant-folded by bundler tracers
// (@vercel/nft, esbuild, webpack), which then try to resolve playwright's
// own optional deps and break the build of any consumer that bundles for
// serverless. In the origin, exactly this pinned production three days
// stale (their DEPLOY-BLOCKER-1, 2026-07-22). A Function-constructor import
// is invisible to every tracer: resolved only at real runtime, only where
// guards 1-2 already passed.

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

type RenderPage = {
  goto: (u: string, o: { waitUntil: string; timeout: number }) => Promise<unknown>;
  content: () => Promise<string>;
  url: () => string;
  click: (selector: string, o: { timeout: number }) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<unknown>;
  evaluate: (fn: string) => Promise<unknown>;
};

/**
 * PARITY-ACTIONS-1 (2026-07-27): steps to run before the page is captured.
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

/**
 * Run caller-supplied actions against an already-loaded page.
 *
 * Every limit here exists because these are instructions driving a browser on
 * our infrastructure:
 *
 *   - the action COUNT and total elapsed time are capped, so a long list
 *     cannot hold a browser open indefinitely;
 *   - a failed step is swallowed rather than fatal — a "Load more" button that
 *     is absent because everything already loaded is the normal end state, not
 *     an error;
 *   - navigation is checked after every step and the run stops if the page
 *     left its origin. A click can navigate, and an action that walked the
 *     browser to another site would turn this into a request forgery with a
 *     real browser behind it.
 *
 * Actions must never be derived from crawled page content. That would let a
 * page we fetched script the browser that fetched it.
 */
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
 * Render a URL with local headless Chromium and return the post-JS HTML, or
 * null when unavailable (wrong runtime, not opted in, playwright absent, or
 * the render failed). Null always means "skip this rung", never an error —
 * the free rung must degrade invisibly on machines that can't run it.
 *
 * Returns HTML (not extracted text) so the caller feeds it through the SAME
 * buildPage path as every other rung — one parser, one guard, one shape.
 */
export async function renderViaLocalChromium(
  url: string,
  enabled: boolean,
  actions: BrowserAction[] = [],
): Promise<string | null> {
  if (!enabled || !url || !hasNodeRuntime()) return null;
  const pw = await importPlaywright();
  if (!pw) return null;

  const chromium = pw.chromium as ChromiumLike;
  let browser: Awaited<ReturnType<ChromiumLike['launch']>> | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
    if (actions.length > 0) await runActions(page, actions, new URL(url).origin);
    const html = await page.content();
    return html && html.length > 0 ? html : null;
  } catch {
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
