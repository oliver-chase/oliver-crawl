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
    newPage: () => Promise<{
      goto: (u: string, o: { waitUntil: string; timeout: number }) => Promise<unknown>;
      content: () => Promise<string>;
    }>;
    close: () => Promise<void>;
  }>;
};

/**
 * Render a URL with local headless Chromium and return the post-JS HTML, or
 * null when unavailable (wrong runtime, not opted in, playwright absent, or
 * the render failed). Null always means "skip this rung", never an error —
 * the free rung must degrade invisibly on machines that can't run it.
 *
 * Returns HTML (not extracted text) so the caller feeds it through the SAME
 * buildPage path as every other rung — one parser, one guard, one shape.
 */
export async function renderViaLocalChromium(url: string, enabled: boolean): Promise<string | null> {
  if (!enabled || !url || !hasNodeRuntime()) return null;
  const pw = await importPlaywright();
  if (!pw) return null;

  const chromium = pw.chromium as ChromiumLike;
  let browser: Awaited<ReturnType<ChromiumLike['launch']>> | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
    const html = await page.content();
    return html && html.length > 0 ? html : null;
  } catch {
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
