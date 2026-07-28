import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { isSecurityRefusal } from '@/fetch/local-render';
import { assertHostResolvesToPublicAddress, assertRedirectUrlAllowedForHost } from '@/fetch/host-policy';

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
    //
    // This slice used to run to END OF FILE, so it swept in the NAVIGATION
    // branch's own route.abort(). QA defeated RENDER-SUBRESOURCE-1 completely —
    // swapping this abort for continue(), letting private-address subresources
    // through — and the whole suite stayed green. Bounded to the subresource
    // branch alone, and comment-stripped so the prose explaining the guard
    // cannot satisfy the assertion.
    const start = renderFn.indexOf('isNavigationRequest');
    const end = renderFn.indexOf('follow the redirect chain OURSELVES');
    expect(end).toBeGreaterThan(start);
    const subresourceBlock = renderFn
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(subresourceBlock).toMatch(/route\.abort\(\)/);
    // The point of the decision: it aborts the REQUEST and lets the render
    // continue. Throwing here would lose the page over a blocked beacon.
    expect(subresourceBlock).not.toMatch(/throw /);
  });
});

describe('security refusals are reported, ordinary unavailability is not', () => {
  // RENDER-SILENT-1 made the render rung report a blocked redirect instead of
  // returning a bare null that looked like an uninstalled browser. Nothing
  // tested that reporting, and the decision is enforced by matching the text
  // of guard error messages — so rewording a guard would turn its reporting
  // off silently.
  //
  // These cases throw from the REAL guards and feed the ACTUAL message through
  // the predicate, so a reworded guard message fails here rather than going
  // quiet in production.
  const privateAddress = async () => [{ address: '127.0.0.1', family: 4 }];

  test.each([
    ['host resolving to a private address', () => assertHostResolvesToPublicAddress('evil.example.com', privateAddress)],
    ['redirect off the requested domain', () => assertRedirectUrlAllowedForHost('site.example.com', '', 'https://other.example.com/x')],
    ['redirect to another port', () => assertRedirectUrlAllowedForHost('site.example.com', '', 'https://site.example.com:8443/x')],
    ['redirect carrying credentials', () => assertRedirectUrlAllowedForHost('site.example.com', '', 'https://u:p@site.example.com/x')],
    ['redirect downgrading to http', () => assertRedirectUrlAllowedForHost('site.example.com', '', 'http://site.example.com/x')],
  ])('%s is reported', async (_name, trigger) => {
    let message: string | null = null;
    try {
      await trigger();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBeNull();
    expect(isSecurityRefusal(message!)).toBe(true);
  });

  test.each([
    'Cannot find module \'playwright\'',
    'Timeout 20000ms exceeded.',
    'page.goto: net::ERR_NAME_NOT_RESOLVED',
    'browserType.launch: Executable doesn\'t exist',
  ])('ordinary unavailability stays silent: %s', (reason) => {
    // The other half of the decision. Reporting everything would train an
    // operator to ignore the signal, which is the same outcome as not having it.
    expect(isSecurityRefusal(reason)).toBe(false);
  });
});
