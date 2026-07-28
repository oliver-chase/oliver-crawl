import { describe, expect, test } from 'vitest';
import { renderViaLocalChromium, runActions, MAX_ACTIONS, MAX_ACTION_TOTAL_MS } from '@/fetch/local-render';
import type { BrowserAction } from '@/fetch/local-render';

// PARITY-ACTIONS-1: these are instructions driving a real browser on our own
// infrastructure. Every bound below exists for that reason, not for tidiness.

type Recorded = { kind: string; arg?: string | number };

const ORIGIN = 'https://site.example.com';

/**
 * A stand-in page. Playwright is not a dependency of this package and its
 * import is written so bundlers cannot see it, which also means it cannot be
 * mocked — so the tests drive `runActions` directly. That is where every
 * bound and the origin check live, so it is the part worth testing.
 */
function fakePage(opts: { urlSequence?: string[]; failClick?: boolean } = {}) {
  const recorded: Recorded[] = [];
  let urlIndex = 0;
  const urls = opts.urlSequence ?? [`${ORIGIN}/x`];

  return {
    recorded,
    page: {
      goto: async () => undefined,
      route: async () => undefined,
      content: async () => '<html></html>',
      url: () => urls[Math.min(urlIndex, urls.length - 1)]!,
      click: async (selector: string) => {
        if (opts.failClick) throw new Error('selector not found');
        recorded.push({ kind: 'click', arg: selector });
        urlIndex++;
      },
      waitForTimeout: async (ms: number) => {
        recorded.push({ kind: 'wait', arg: ms });
      },
      evaluate: async () => {
        recorded.push({ kind: 'scroll' });
        return undefined;
      },
    },
  };
}

const run = (fake: ReturnType<typeof fakePage>, actions: BrowserAction[]) =>
  runActions(fake.page, actions, ORIGIN);

describe('action bounds are enforced by the library, not the caller', () => {
  test('the action count is capped', () => {
    // A caller cannot raise these; they are constants, not options.
    expect(MAX_ACTIONS).toBe(10);
    expect(MAX_ACTION_TOTAL_MS).toBe(20_000);
  });

  test('no actions means nothing runs', async () => {
    const fake = fakePage();
    await run(fake, []);
    expect(fake.recorded).toEqual([]);
  });

  test('a list longer than the cap is truncated', async () => {
    const fake = fakePage();
    const many: BrowserAction[] = Array.from({ length: 25 }, () => ({ type: 'scroll', times: 1 }));
    await run(fake, many);
    expect(fake.recorded.filter((r) => r.kind === 'scroll')).toHaveLength(MAX_ACTIONS);
  });
});

describe('a failing step is skipped, not fatal', () => {
  test('a missing "Load more" selector does not stop the run', async () => {
    // The normal end state: the button is gone because everything loaded.
    const fake = fakePage({ failClick: true });
    await expect(run(fake, [{ type: 'click', selector: '.load-more' }, { type: 'scroll' }])).resolves.toBeUndefined();
    expect(fake.recorded.some((r) => r.kind === 'scroll')).toBe(true);
  });
});

describe('actions cannot walk the browser off-origin', () => {
  test('a click that navigates away stops the remaining actions', async () => {
    // A click can navigate. Continuing to script a page we never vetted would
    // be a request forgery with a real browser behind it.
    const fake = fakePage({
      urlSequence: [`${ORIGIN}/x`, 'https://attacker.example.net/landing'],
    });

    await run(fake, [
      { type: 'click', selector: '.first' },
      { type: 'click', selector: '.second' },
      { type: 'scroll', times: 3 },
    ]);

    // Only the first click ran; everything after the origin change is dropped.
    expect(fake.recorded.filter((r) => r.kind === 'click')).toHaveLength(1);
    expect(fake.recorded.some((r) => r.kind === 'scroll')).toBe(false);
  });
});

describe('scroll and wait behave as specified', () => {
  test('scroll repeats up to its requested count', async () => {
    const fake = fakePage();
    await run(fake, [{ type: 'scroll', times: 3 }]);
    expect(fake.recorded.filter((r) => r.kind === 'scroll')).toHaveLength(3);
  });

  test('a single wait is clamped', async () => {
    const fake = fakePage();
    await run(fake, [{ type: 'wait', ms: 999_999 }]);
    const wait = fake.recorded.find((r) => r.kind === 'wait');
    expect(wait!.arg).toBeLessThanOrEqual(5_000);
  });
});

describe('rendering is still opt-in', () => {
  test('actions do nothing when local rendering is disabled', async () => {
    // Actions must not become a way to turn rendering on implicitly.
    const result = await renderViaLocalChromium('https://venue.example.com/x', false, [
      { type: 'click', selector: '.load-more' },
    ]);
    expect(result).toBeNull();
  });
});
