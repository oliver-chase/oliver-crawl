import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

// RENDER-HOP-2: the render rung must follow redirects ITSELF.
//
// RENDER-HOP-1 added a per-hop check inside the route handler and called
// route.continue(). QA showed the check never ran: Chromium follows 3xx inside
// its network stack, so the handler sees only the ORIGINAL request. Driving a
// real `site -> off-site -> site` chain, the handler saw ONE request while
// three responses arrived — the off-site server received a real request, and
// the post-goto landing check passed because the chain came home.
//
// A guard that is present and correct but never invoked is the failure mode
// this file exists to prevent, so these assertions are about WIRING, not about
// the guard's logic (that is covered where the guard lives).
//
// playwright's import is deliberately invisible to bundlers, so the function
// around it cannot be mocked and the wiring cannot be asserted behaviourally.
// The live suite drives the real chain; this keeps a refactor from undoing it
// without a browser present.

const source = readFileSync(new URL('../../src/fetch/local-render.ts', import.meta.url), 'utf8');
// Anchored on the comment INSIDE the handler, not on the decision id — the id
// also appears on the type declaration far above, and slicing from there swept
// in unrelated code. A sibling test in this repo failed exactly that way by
// slicing to end-of-file and matching the OTHER branch's route.abort().
const navigationBranchRaw = source.slice(
  source.indexOf('follow the redirect chain OURSELVES'),
  source.indexOf('await page.goto('),
);

/**
 * Comments stripped before matching. The branch's own comment EXPLAINS why
 * route.continue() is wrong, so a test reading raw text matches the prose and
 * fails on correct code — it would be asserting against the documentation
 * rather than the behaviour.
 */
const navigationBranch = navigationBranchRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

describe('the render rung follows redirects itself', () => {
  test('navigation hops are fetched with redirects disabled', () => {
    // The whole defect in one assertion: maxRedirects: 0 is what stops
    // Chromium following the chain where the guard cannot see it.
    expect(navigationBranch).toMatch(/maxRedirects:\s*0/);
  });

  test('the navigation branch does not hand the request back to Chromium', () => {
    // route.continue() on a navigation request restores the defect exactly:
    // the network stack takes over and every subsequent hop is invisible.
    expect(navigationBranch).not.toMatch(/route\.continue\(\)/);
  });

  test('each hop is validated before its request is made', () => {
    const guardAt = navigationBranch.indexOf('assertLandedSameSite');
    const fetchAt = navigationBranch.indexOf('route.fetch');
    expect(guardAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(-1);
    // Order is the point. Validating after the fetch is the original bug in a
    // new shape: the private server has already received the request.
    expect(guardAt).toBeLessThan(fetchAt);
  });

  test('the chain is bounded', () => {
    // Following redirects by hand means owning the loop, and a loop without a
    // ceiling is a spin.
    expect(navigationBranch).toMatch(/MAX_REDIRECT_HOPS/);
  });
});
