import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

// RENDER-HOP-1 / RENDER-REDIRECT-1 wiring guard.
//
// QA showed both call sites could be deleted from renderViaLocalChromium while
// leaving assertLandedSameSite intact, and the whole suite stayed green with a
// clean typecheck — the behavioural tests only exercise the pure helper, so a
// refactor could reintroduce the exact vulnerability with a green build.
//
// playwright's import is deliberately invisible to bundlers, so the function
// around it cannot be mocked and the wiring cannot be asserted behaviourally
// in a unit test. This reads the source instead. It is a blunt instrument and
// it is the honest one: it fails loudly if the guard is unwired, which is the
// only property that matters here.

const SOURCE = readFileSync(new URL('../../src/fetch/local-render.ts', import.meta.url), 'utf8');
const renderFn = SOURCE.slice(SOURCE.indexOf('export async function renderViaLocalChromium('));

describe('the landing guard stays wired into the render path', () => {
  test('the landing is validated after goto', () => {
    expect(renderFn).toMatch(/await assertLandedSameSite\(page\.url\(\), url, dnsLookup\)/);
  });

  test('it is validated again after browser actions can navigate', () => {
    const calls = renderFn.match(/assertLandedSameSite\(page\.url\(\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  test('every navigation hop is intercepted, not just the landing', () => {
    expect(renderFn).toMatch(/page\.route\(/);
    expect(renderFn).toMatch(/isNavigationRequest\(\)/);
    expect(renderFn).toMatch(/route\.abort\(\)/);
  });

  test('a blocked hop aborts the render rather than returning content', () => {
    expect(renderFn).toMatch(/blockedHops\.length > 0.*throw|throw new Error\(`Render blocked a redirect hop/s);
  });
});

describe('subresource requests are screened too', () => {
  // RENDER-SUBRESOURCE-1: page JS fetching a CORS-permissive service on a
  // private address landed the body in the DOM, which then left in
  // page.content(). The navigation guard never saw those requests.
  test('non-navigation requests are resolution-checked', () => {
    expect(renderFn).toMatch(/isNavigationRequest\(\)/);
    expect(renderFn).toMatch(/assertHostResolvesToPublicAddress\(new URL\(request\.url\(\)\)/);
  });

  test('a blocked subresource aborts the request, not the render', () => {
    // A blocked tracker or internal beacon must not lose the page.
    const subresourceBlock = renderFn.slice(renderFn.indexOf('isNavigationRequest'));
    expect(subresourceBlock).toMatch(/route\.abort\(\)/);
  });
});
