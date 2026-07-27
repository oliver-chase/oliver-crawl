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
  /** Selector for the repeating per-event node on a listing page. */
  itemSelector: string;
  fields: Partial<Record<'title' | 'dateText' | 'venueName' | 'priceText' | 'ticketUrl', RecipeFieldRule>>;
  learnedFromUrl: string;
};

export type RecipeDraft = {
  title: string;
  dateText: string | null;
  venueName: string | null;
  priceText: string | null;
  ticketUrl: string | null;
};

export const MAX_RECIPE_FAILURES = 2;
/** Minimum items a recipe must yield on a listing page to be trusted. */
const MIN_RECIPE_ITEMS = 2;
/** Share of recipe drafts whose dateText must parse for the output to validate. */
const MIN_DATE_PARSE_RATE = 0.7;

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
      const title = read(recipe.fields.title);
      if (!title) return;
      drafts.push({
        title,
        dateText: read(recipe.fields.dateText),
        venueName: read(recipe.fields.venueName),
        priceText: read(recipe.fields.priceText),
        ticketUrl: read(recipe.fields.ticketUrl),
      });
    });
  } catch {
    return null; // bad selector syntax — treat as a validation failure upstream
  }
  return drafts.length >= MIN_RECIPE_ITEMS ? drafts : null;
}
