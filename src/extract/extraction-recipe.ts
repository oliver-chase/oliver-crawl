// ─── Extraction recipes: the REPLAY half ────────────────────────────────────
//
// A recipe is a learned set of CSS selectors for a specific site's listing
// page. Replaying one is deterministic and free: no LLM, no vendor call, just
// selectors against HTML. That is the whole point — once a site's shape is
// known, re-reading it should never cost anything again.
//
// ONLY the replay half lives here. The LEARN half (learnRecipe,
// learnAndVerifyRecipe, validateRecipeDrafts, recipeAgreesWithLlm) stays in
// the consuming app, because it is not generic: it calls an LLM to propose
// selectors and validates the result with domain rules — in the origin repo,
// event date parsing and venue-name heuristics. A different consumer learns
// recipes against its OWN domain's validity rules.
//
// This split corrects the original extraction spec, which listed
// extraction-recipe as fully generic. It is not; only this part is.
//
// Cheerio is imported lazily so a runtime without it (workerd) degrades to
// "recipes do not run here" instead of failing to load the module.

export type RecipeFieldRule = {
  /** CSS selector relative to the item node ('' = the item node itself). */
  selector: string;
  /** Read this attribute instead of text content (e.g. href for ticketUrl). */
  attr?: string;
};

export type ExtractionRecipe = {
  version: 1;
  /** Selector for the repeating item node on a listing page. */
  itemSelector: string;
  /**
   * Field name to selector. The names are the CONSUMER's, not this library's:
   * a listings site wants title and price, a jobs board wants role and salary.
   * These were once a fixed union of one consumer's event fields, which made a
   * reusable library carry one domain's schema.
   */
  fields: Record<string, RecipeFieldRule>;
  /**
   * Field an item must yield to count. A listing row that matched the item
   * selector but produced no name is a selector that no longer fits the page,
   * and keeping it lets a recipe go on succeeding against a redesigned site
   * while returning empty rows. Which field carries that weight is the
   * consumer's call; unset means an item is dropped only when EVERY field
   * comes back empty.
   */
  requiredField?: string;
  learnedFromUrl: string;
};

/** One extracted item, keyed by the recipe's own field names. */
export type RecipeDraft = Record<string, string | null>;

export const MAX_RECIPE_FAILURES = 2;
/** Minimum items a recipe must yield on a listing page to be trusted. */
const MIN_RECIPE_ITEMS = 2;

type CheerioModule = typeof import('cheerio');
let cheerioModule: CheerioModule | null = null;
async function loadCheerio(): Promise<CheerioModule | null> {
  if (cheerioModule) return cheerioModule;
  try {
    cheerioModule = await import('cheerio');
    return cheerioModule;
  } catch {
    return null; // workerd — recipes simply don't run here
  }
}

function isRecipeShape(value: unknown): value is ExtractionRecipe {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<ExtractionRecipe>;
  return r.version === 1 && typeof r.itemSelector === 'string' && r.itemSelector.length > 0 && !!r.fields && typeof r.fields === 'object';
}

export function parseStoredRecipe(raw: unknown): ExtractionRecipe | null {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  return isRecipeShape(raw) ? raw : null;
}

/** Run a recipe against page HTML. Returns null when cheerio is unavailable
 *  or the recipe yields too few items to trust. */
export async function applyRecipe(html: string, recipe: ExtractionRecipe): Promise<RecipeDraft[] | null> {
  const cheerio = await loadCheerio();
  if (!cheerio) return null;
  let drafts: RecipeDraft[];
  try {
    const $ = cheerio.load(html);
    const items = $(recipe.itemSelector);
    drafts = [];
    items.each((_, el) => {
      const read = (rule: RecipeFieldRule | undefined): string | null => {
        if (!rule) return null;
        const node = rule.selector ? $(el).find(rule.selector).first() : $(el);
        if (node.length === 0) return null;
        const value = rule.attr ? node.attr(rule.attr) : node.text();
        const trimmed = (value || '').replace(/\s+/g, ' ').trim();
        return trimmed || null;
      };
      const draft: RecipeDraft = {};
      for (const [name, rule] of Object.entries(recipe.fields)) draft[name] = read(rule);
      const required = recipe.requiredField;
      if (required ? draft[required] === null : Object.values(draft).every((v) => v === null)) return;
      drafts.push(draft);
    });
  } catch {
    return null; // bad selector syntax — treat as a validation failure upstream
  }
  return drafts.length >= MIN_RECIPE_ITEMS ? drafts : null;
}
