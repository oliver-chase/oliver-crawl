// TEMPLATE-1: the LLM writes the extractor; determinism runs it.
// These pin the REPLAY half only — applyRecipe + parseStoredRecipe — which is
// what moved into this package. The learn half (and its domain-specific
// validation gates) stays in the consuming app; see the module header.
import { describe, expect, test } from 'vitest';
import {
  applyRecipe,
  parseStoredRecipe,
  type ExtractionRecipe,
} from '@/extract/extraction-recipe';

const PAGE = `
<html><body>
  <div class="event-card"><h3 class="title">Bluegrass Night</h3><span class="when">July 24, 2026 7:00 PM</span><span class="where">Iron Smoke Distillery</span><a class="tix" href="/tickets/1">Tickets</a></div>
  <div class="event-card"><h3 class="title">Jazz Evening</h3><span class="when">July 31, 2026 8:00 PM</span><span class="where">Iron Smoke Distillery</span><a class="tix" href="/tickets/2">Tickets</a></div>
  <div class="event-card"><h3 class="title">Folk Sunday</h3><span class="when">August 2, 2026 3:00 PM</span><span class="where">Iron Smoke Distillery</span><a class="tix" href="/tickets/3">Tickets</a></div>
</body></html>`;

const RECIPE: ExtractionRecipe = {
  version: 1,
  itemSelector: '.event-card',
  fields: {
    title: { selector: '.title' },
    dateText: { selector: '.when' },
    venueName: { selector: '.where' },
    ticketUrl: { selector: 'a.tix', attr: 'href' },
  },
  learnedFromUrl: 'https://venue.test/events',
};

describe('applyRecipe', () => {
  test('extracts every templated item with all fields', async () => {
    const drafts = await applyRecipe(PAGE, RECIPE);
    expect(drafts).toHaveLength(3);
    expect(drafts![0]).toMatchObject({
      title: 'Bluegrass Night',
      dateText: 'July 24, 2026 7:00 PM',
      venueName: 'Iron Smoke Distillery',
      ticketUrl: '/tickets/1',
    });
  });

  test('a redesigned page (selector matches nothing) returns null, not empty junk', async () => {
    const drafts = await applyRecipe('<html><body><ul><li>totally different markup</li></ul></body></html>', RECIPE);
    expect(drafts).toBe(null);
  });

  test('items without a title are dropped; below the minimum the page is rejected', async () => {
    const onlyOne = PAGE.replace(/<h3 class="title">Jazz Evening<\/h3>/, '').replace(/<h3 class="title">Folk Sunday<\/h3>/, '');
    const drafts = await applyRecipe(onlyOne, RECIPE);
    expect(drafts).toBe(null);
  });

  test('bad selector syntax degrades to null instead of throwing', async () => {
    const bad = { ...RECIPE, itemSelector: ':::not-a-selector(((' };
    expect(await applyRecipe(PAGE, bad)).toBe(null);
  });
});

describe('parseStoredRecipe', () => {
  test('accepts object or JSON-string jsonb; rejects malformed shapes', () => {
    expect(parseStoredRecipe(RECIPE)).toEqual(RECIPE);
    expect(parseStoredRecipe(JSON.stringify(RECIPE))).toEqual(RECIPE);
    expect(parseStoredRecipe({ version: 2, itemSelector: 'x' })).toBe(null);
    expect(parseStoredRecipe('not json')).toBe(null);
    expect(parseStoredRecipe(null)).toBe(null);
  });
});
