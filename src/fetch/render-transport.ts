// ─── The render rung's browser and transport ────────────────────────────────
//
// One shared Chromium per process, and every request a rendered page makes,
// fetched through the crawler's pinned connection pool so the browser never
// resolves a host itself.

import { pooledFetchFor } from './connection-pool.js';
import { dropBody, readBytesPrefix } from './http-mechanics.js';
import type { RenderPage } from './local-render.js';

export const RENDER_TIMEOUT_MS = 20_000;
/** The largest body the render rung hands to the browser. The text path caps at 2 MB, so this leaves room for markup. */
export const MAX_RENDER_BODY_BYTES = 5_000_000;

export type RenderBrowser = {
  newContext: (options: { serviceWorkers: 'block' }) => Promise<{
    newPage: () => Promise<RenderPage>;
    addInitScript: (script: string) => Promise<void>;
    close: () => Promise<void>;
  }>;
  close: () => Promise<void>;
  isConnected: () => boolean;
};

export type ChromiumLike = { launch: (opts: { headless: boolean }) => Promise<RenderBrowser> };

/** An idle shared browser closes after this long, so a process that renders once does not keep Chromium running. */
const BROWSER_IDLE_MS = 30_000;

/**
 * One Chromium per process, shared by every render, each in its own context so no cookies or storage
 * cross between pages. Launching costs about a second, which a crawl that renders many pages pays once.
 */
let sharedBrowser: Promise<RenderBrowser> | null = null;
let activeRenders = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

export async function acquireBrowser(chromium: ChromiumLike): Promise<RenderBrowser> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  activeRenders += 1;
  const current = sharedBrowser ? await sharedBrowser.catch(() => null) : null;
  if (!current || !current.isConnected()) {
    sharedBrowser = chromium.launch({ headless: true });
    sharedBrowser.catch(() => {
      sharedBrowser = null;
    });
  }
  return sharedBrowser!;
}

export function releaseBrowser(): void {
  activeRenders -= 1;
  if (activeRenders > 0) return;
  idleTimer = setTimeout(() => {
    const closing = sharedBrowser;
    sharedBrowser = null;
    void closing?.then((b) => b.close()).catch(() => {});
  }, BROWSER_IDLE_MS);
  // The timer never holds the process open.
  (idleTimer as { unref?: () => void }).unref?.();
}

export type RenderRoute = {
  request: () => {
    url: () => string;
    method: () => string;
    headers: () => Record<string, string>;
    postDataBuffer: () => Buffer | null;
    isNavigationRequest: () => boolean;
    frame: () => unknown;
  };
  abort: () => Promise<unknown>;
  // Every request is made by the crawler's own pinned fetch and handed back to the page, so Chromium
  // never resolves a host itself and a name cannot answer public to the check and private to the browser.
  fulfill: (options: { status: number; headers: Record<string, string>; body: Buffer }) => Promise<unknown>;
};

/** Headers that describe the wire encoding, which the fetch has already undone. */
const WIRE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

/** Make one request through the pinned pool with redirects off, and read at most the render cap of its body. */
export async function pinnedRequest(
  pinnedFetch: typeof fetch,
  request: ReturnType<RenderRoute['request']>,
  url: string,
): Promise<{ status: number; headers: Record<string, string>; location: string | null; body: Buffer; capped: boolean }> {
  const postData = request.postDataBuffer();
  const response = await pinnedFetch(url, {
    method: request.method(),
    headers: request.headers(),
    ...(postData ? { body: new Uint8Array(postData) } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
  });
  const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
  if (location) {
    dropBody(response);
    return { status: response.status, headers: {}, location, body: Buffer.alloc(0), capped: false };
  }
  const { bytes, capped } = await readBytesPrefix(response, MAX_RENDER_BODY_BYTES);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (!WIRE_HEADERS.has(key)) headers[key] = value;
  });
  return { status: response.status, headers, location: null, body: Buffer.from(bytes), capped };
}
