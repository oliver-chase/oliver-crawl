// ─── What structured data does this page actually carry? ────────────────────
//
// JSONLD-SIGNAL-1 (2026-07-27): the single largest cost lever a crawl package
// has over its consumer's bill.
//
// The expensive part of a crawl pipeline is not the crawl — it is the LLM
// extraction afterwards. A page that publishes complete schema.org data needs
// NO model at all: reading it is free, exact, and can't hallucinate. A page
// that publishes nothing needs one.
//
// We already returned `jsonLd: unknown[]`, and every consumer then wrote the
// same awkward loop to answer "is any of this actually useful?" — because the
// majority of JSON-LD in the wild is site furniture. A typical venue page
// emits `WebSite`, `Organization` and `BreadcrumbList` and not one word about
// the events on it. A consumer that checks `jsonLd.length > 0` and skips the
// LLM on that page silently extracts nothing.
//
// So the package answers the generic half of the question — WHAT is here, and
// is any of it about the page's content rather than about the site — and the
// caller keeps the domain half, which is whether those particular fields are
// enough for them. That is the same split used everywhere else here.

/**
 * schema.org types that describe the SITE or the page's furniture rather than
 * its content. Their presence tells you nothing about whether the page's
 * subject matter is machine-readable.
 */
const BOILERPLATE_TYPES = new Set(
  [
    'WebSite',
    'WebPage',
    'CollectionPage',
    'ItemPage',
    'AboutPage',
    'ContactPage',
    'SearchResultsPage',
    'ProfilePage',
    'BreadcrumbList',
    'SiteNavigationElement',
    'WPHeader',
    'WPFooter',
    'WPSideBar',
    'Organization',
    'ImageObject',
    'SearchAction',
    'EntryPoint',
    'ListItem',
  ].map((t) => t.toLowerCase()),
);

export type StructuredSummary = {
  /** Every distinct `@type` found anywhere in the page's JSON-LD. */
  types: string[];
  /**
   * The subset of `types` that describes the page's CONTENT rather than the
   * site around it — Event, Product, Recipe, Article, LocalBusiness and so on.
   */
  contentTypes: string[];
  /** How many JSON-LD nodes were found in total (after flattening @graph). */
  nodeCount: number;
  /**
   * True when at least one content-bearing node exists.
   *
   * The practical test: `false` means an LLM is the only way to get anything
   * off this page. `true` means try the structured data FIRST — it is free
   * and exact — and fall back to a model only for what it did not answer.
   */
  hasContentData: boolean;
};

/** Pull every `@type` off a node, tolerating the string / array / absent forms. */
function typesOf(node: Record<string, unknown>): string[] {
  const raw = node['@type'];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string');
  return [];
}

/**
 * Flatten JSON-LD into a list of nodes.
 *
 * Real-world JSON-LD nests in three different shapes and a consumer that
 * handles only the top level misses most of it: a bare object, an array of
 * objects, or an `@graph` wrapper (which is what most CMS plugins emit).
 * Nested objects count too — an Event's `location` is a Place, and a page
 * whose only Event sits inside a `@graph` is still an Event page.
 */
function flattenNodes(value: unknown, out: Array<Record<string, unknown>>, depth = 0): void {
  // Bounded: JSON-LD is caller-untrusted input, and a deeply self-nested
  // document should cost bounded work rather than blow the stack.
  if (depth > 8 || out.length > 500) return;

  if (Array.isArray(value)) {
    for (const item of value) flattenNodes(item, out, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const node = value as Record<string, unknown>;
  if (typesOf(node).length > 0) out.push(node);

  for (const [key, child] of Object.entries(node)) {
    if (key === '@context' || key === '@type') continue;
    if (child && typeof child === 'object') flattenNodes(child, out, depth + 1);
  }
}

/**
 * Summarise a page's JSON-LD.
 *
 * ```ts
 * if (page.structuredData.hasContentData) {
 *   useJsonLd(page.jsonLd);        // free and exact
 * } else {
 *   await extractWithModel(page.markdown);  // the paid path
 * }
 * ```
 */
export function summarizeStructuredData(jsonLd: unknown[]): StructuredSummary {
  const nodes: Array<Record<string, unknown>> = [];
  for (const entry of jsonLd) flattenNodes(entry, nodes);

  const seen = new Set<string>();
  const contentSeen = new Set<string>();

  for (const node of nodes) {
    for (const type of typesOf(node)) {
      // '@type' is sometimes a full IRI (http://schema.org/Event).
      const name = type.split(/[/#]/).pop() || type;
      if (!name) continue;
      seen.add(name);
      if (!BOILERPLATE_TYPES.has(name.toLowerCase())) contentSeen.add(name);
    }
  }

  const contentTypes = [...contentSeen].sort();
  return {
    types: [...seen].sort(),
    contentTypes,
    nodeCount: nodes.length,
    hasContentData: contentTypes.length > 0,
  };
}
