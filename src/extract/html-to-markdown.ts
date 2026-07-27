// ─── HTML to Markdown ───────────────────────────────────────────────────────
//
// VENDOR-PARITY-1 (2026-07-27): markdown is Firecrawl's headline output, and
// the single clearest reason a caller reaches for it instead of the free lane.
// It is not a cosmetic format choice — it is an ACCURACY lever.
//
// Plain visible text flattens a page. This:
//
//     Summer Concert Series
//     July 11 The Hold Steady 7:00 PM $25
//     July 18 Waxahatchee 7:30 PM Free
//
// is what `page.text` gives you for a table, and an LLM asked to pull events
// out of it has to guess which token is a date, a act, a time, a price — and
// which row each belongs to. The same region as markdown:
//
//     ## Summer Concert Series
//     | Date | Artist | Time | Price |
//     | --- | --- | --- | --- |
//     | July 11 | The Hold Steady | 7:00 PM | $25 |
//
// carries the structure the page's author already encoded. Headings scope
// their sections, lists keep items separate, tables keep columns aligned to
// meaning, and links keep their text attached to their href. Every one of
// those is information that was in the HTML and that plain-text extraction
// throws away before the model ever sees it.
//
// Scoped to the main-content region, so nav, footers, cookie banners and
// sidebars never reach the model either — Firecrawl's `onlyMainContent`,
// which we already had the logic for (extract/content-region-hash.ts) and
// were using ONLY to compute a change hash.
//
// Deliberately hand-written rather than pulling in Turndown: the tag set that
// actually matters for content extraction is small, and a dependency here
// would have to be audited for the same prompt-injection and ReDoS concerns
// as everything else in this package.

import type { CheerioAPI, Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';

/** Regions that are page furniture, never content. */
const CHROME_SELECTOR = 'nav, header, footer, aside, script, style, noscript, template, svg, form';

/** Escape the characters that would otherwise be read as markdown syntax. */
function escapeInline(text: string): string {
  return text.replace(/([\\`*_[\]])/g, '\\$1');
}

function collapse(text: string): string {
  return text.replace(/[ \t\r\n]+/g, ' ');
}

/**
 * The main-content root, in order of confidence:
 *
 *   1. The first `<main>` or `<article>` — the author told us, believe them.
 *   2. PARITY-READABILITY-1 (2026-07-27): on div-soup pages that never use
 *      semantic tags, score the content the Readability way — paragraphs
 *      vote for their parent — and take the winning cluster.
 *   3. `<body>`, when nothing scores — chrome stripping is then all we have.
 *
 * On the change hash: extract/content-region-hash.ts stays on its regex
 * region (semantic-or-body), so on div-soup pages the hash covers a SUPERSET
 * of the markdown scope. The divergence is deliberate and safe in exactly
 * one direction — the hash may report "changed" when the markdown region
 * did not move (a wasted re-extraction), never "unchanged" when it did
 * (silently stale data).
 */
export function selectMainRegion($: CheerioAPI): Cheerio<AnyNode> {
  for (const tag of ['main', 'article']) {
    const found = $(tag).first();
    if (found.length > 0) return found as Cheerio<AnyNode>;
  }
  const scored = scoreContentParent($);
  if (scored) return scored;
  return $('body') as Cheerio<AnyNode>;
}

/**
 * Readability's core move, simplified: paragraphs vote for their parent.
 *
 * Every text-bearing `<p>` adds its non-link text length to its parent's
 * score, discounted by link density — a paragraph that is mostly links is a
 * menu wearing a <p> tag, and gets almost no vote. The parent with the most
 * votes is where the prose lives; link farms, sidebars and footer nav score
 * near zero because their text IS their links.
 *
 * Guardrails, because a wrong pick here silently loses content:
 *   - a winner must hold a meaningful share (>= 40%) of the page's total
 *     paragraph mass — a page whose text is spread thin has no clear main
 *     region, and body-with-chrome-stripped is the honest answer;
 *   - fewer than 2 scoring paragraphs is no signal at all.
 */
function scoreContentParent($: CheerioAPI): Cheerio<AnyNode> | null {
  const scores = new Map<AnyNode, number>();
  let totalMass = 0;
  let scoringParagraphs = 0;

  $('p').each((_, p) => {
    const $p = $(p);
    // READABILITY-CHROME-1 (2026-07-27, found in review): a paragraph inside
    // nav/header/footer/aside is furniture and must not vote. Without this a
    // prose-heavy sidebar outscores a short real article and is returned AS
    // the main region — and because the winner is then a DESCENDANT of the
    // chrome element, the later chrome strip cannot undo it (it removes
    // chrome inside the scope, not the scope's own ancestors).
    if ($p.closest(CHROME_SELECTOR).length > 0) return;

    const text = $p.text().trim();
    if (text.length < 25) return; // too short to be prose

    const linkText = $p.find('a').text().trim();
    const linkDensity = text.length > 0 ? linkText.length / text.length : 1;
    const vote = text.length * (1 - linkDensity);
    if (vote <= 0) return;

    scoringParagraphs++;
    totalMass += vote;
    const parent = $p.parent().get(0);
    if (parent) scores.set(parent, (scores.get(parent) ?? 0) + vote);
  });

  if (scoringParagraphs < 2 || totalMass === 0) return null;

  let best: AnyNode | null = null;
  let bestScore = 0;
  for (const [node, score] of scores) {
    if (score > bestScore) {
      best = node;
      bestScore = score;
    }
  }

  if (!best || bestScore / totalMass < 0.4) return null;
  return $(best) as Cheerio<AnyNode>;
}

/**
 * Convert a page's main content region to Markdown.
 *
 * Mutates nothing the caller can see: chrome is removed from a CLONE, because
 * `buildPage` goes on to read links from the same tree and would otherwise
 * lose every nav link — which is exactly how a site's calendar link
 * disappears.
 */
export function htmlToMarkdown($: CheerioAPI, options: { maxChars?: number } = {}): string {
  const region = selectMainRegion($);
  if (region.length === 0) return '';

  // Clone before stripping — see the note above.
  const scope = region.clone();
  scope.find(CHROME_SELECTOR).remove();

  const blocks: string[] = [];
  renderChildren($, scope, blocks, { listDepth: 0 });

  let out = blocks
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const cap = options.maxChars;
  if (cap && out.length > cap) out = `${out.slice(0, cap)}\n[TRUNCATED]`;
  return out;
}

type Ctx = { listDepth: number };

function renderChildren($: CheerioAPI, node: Cheerio<AnyNode>, blocks: string[], ctx: Ctx): void {
  node.contents().each((_, el) => renderNode($, $(el) as Cheerio<AnyNode>, el, blocks, ctx));
}

function renderNode($: CheerioAPI, $el: Cheerio<AnyNode>, el: AnyNode, blocks: string[], ctx: Ctx): void {
  if (el.type === 'text') {
    const text = collapse($el.text());
    if (text.trim()) blocks.push(escapeInline(text.trim()));
    return;
  }
  if (el.type !== 'tag') return;

  const tag = (el as { name: string }).name.toLowerCase();

  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number(tag[1]);
      const text = inline($, $el);
      if (text) blocks.push(`${'#'.repeat(level)} ${text}`);
      return;
    }

    case 'p':
    case 'div':
    case 'section':
    case 'blockquote': {
      // A div is a layout box, not a semantic block — recurse so nested
      // headings/lists/tables are still recognised rather than flattened.
      if (tag === 'div' || tag === 'section') {
        renderChildren($, $el, blocks, ctx);
        return;
      }
      const text = inline($, $el);
      if (text) blocks.push(tag === 'blockquote' ? `> ${text}` : text);
      return;
    }

    case 'ul':
    case 'ol': {
      const ordered = tag === 'ol';
      const items: string[] = [];
      $el.children('li').each((index, li) => {
        const text = inline($, $(li) as Cheerio<AnyNode>);
        if (!text) return;
        const marker = ordered ? `${index + 1}.` : '-';
        items.push(`${'  '.repeat(ctx.listDepth)}${marker} ${text}`);
      });
      if (items.length) blocks.push(items.join('\n'));
      return;
    }

    case 'table': {
      const rendered = renderTable($, $el);
      if (rendered) blocks.push(rendered);
      return;
    }

    case 'pre': {
      const code = $el.text().replace(/\s+$/, '');
      if (code.trim()) blocks.push(`\`\`\`\n${code}\n\`\`\``);
      return;
    }

    case 'img': {
      // A block-level image, not wrapped in a paragraph. Common for flyers,
      // and its alt text is often the only description of the event — the
      // default branch would recurse into a childless node and emit nothing.
      const rendered = inlineImage($, $el);
      if (rendered) blocks.push(rendered);
      return;
    }

    case 'hr':
      blocks.push('---');
      return;

    case 'br':
      return;

    default:
      renderChildren($, $el, blocks, ctx);
  }
}

/**
 * Render one <img> as markdown. Shared by the block and inline paths.
 *
 * MARKDOWN-DATAURI-1 (2026-07-27, found by scripts/parity-check.mjs on a live
 * site): a `data:` src is never emitted. Lazy-loading libraries put a 1x1
 * base64 PNG in `src` and the real URL in `data-src`, and emitting that
 * base64 blob tripped the injection guard's encoded-payload rule — which
 * quarantined an ordinary page and would have done so for every site using
 * the pattern, which is most of them.
 *
 * Dropping it costs nothing: an extractor cannot read pixels, so a data URI
 * carries no information a consumer can use. The alt text is kept, since it
 * is frequently the only description of the image.
 */
function inlineImage($: CheerioAPI, $img: Cheerio<AnyNode>): string {
  const alt = ($img.attr('alt') || '').trim();
  const rawSrc = ($img.attr('src') || '').trim();
  // Prefer the real URL a lazy-loader parked in data-src over its placeholder.
  const src = /^data:/i.test(rawSrc) ? ($img.attr('data-src') || '').trim() : rawSrc;

  if (/^data:/i.test(src) || (!alt && !src)) return alt ? escapeInline(alt) : '';
  if (!src) return escapeInline(alt);
  return `![${escapeInline(alt)}](${src})`;
}

/** Inline-render an element's contents: links, emphasis and images kept. */
function inline($: CheerioAPI, $el: Cheerio<AnyNode>): string {
  const parts: string[] = [];

  $el.contents().each((_, node) => {
    if (node.type === 'text') {
      parts.push(escapeInline(collapse($(node).text())));
      return;
    }
    if (node.type !== 'tag') return;

    const $node = $(node) as Cheerio<AnyNode>;
    const tag = (node as { name: string }).name.toLowerCase();

    switch (tag) {
      case 'a': {
        const href = $node.attr('href') || '';
        const text = inline($, $node).trim();
        // A link with no text carries nothing an extractor can use.
        if (!text) return;
        parts.push(href ? `[${text}](${href})` : text);
        return;
      }
      case 'img': {
        // Alt text is often the ONLY description of a flyer image, and event
        // pages lean on it heavily — keep it rather than dropping the node.
        parts.push(inlineImage($, $node));
        return;
      }
      case 'strong':
      case 'b': {
        const text = inline($, $node).trim();
        if (text) parts.push(`**${text}**`);
        return;
      }
      case 'em':
      case 'i': {
        const text = inline($, $node).trim();
        if (text) parts.push(`*${text}*`);
        return;
      }
      case 'code': {
        const text = $node.text().trim();
        if (text) parts.push(`\`${text}\``);
        return;
      }
      case 'br':
        parts.push(' ');
        return;
      case 'script':
      case 'style':
      case 'noscript':
        return;
      default:
        parts.push(inline($, $node));
    }
  });

  return collapse(parts.join('')).trim();
}

/**
 * Render a table as a markdown pipe table.
 *
 * Worth the effort: schedules, lineups and opening hours are overwhelmingly
 * published as tables, and they are precisely the content whose meaning dies
 * in a flat text dump — the column a cell belonged to is the thing that says
 * whether "7:00 PM" is a start time or a door time.
 */
function renderTable($: CheerioAPI, $table: Cheerio<AnyNode>): string {
  const rows: string[][] = [];

  $table.find('tr').each((_, tr) => {
    const cells: string[] = [];
    $(tr)
      .children('th, td')
      .each((__, cell) => {
        // Pipes inside a cell would break the table structure.
        cells.push(inline($, $(cell) as Cheerio<AnyNode>).replace(/\|/g, '\\|'));
      });
    if (cells.some((c) => c.trim())) rows.push(cells);
  });

  if (rows.length === 0) return '';

  const width = Math.max(...rows.map((r) => r.length));
  const pad = (row: string[]) => {
    const filled = [...row];
    while (filled.length < width) filled.push('');
    return `| ${filled.join(' | ')} |`;
  };

  // A single-row table is a layout hack, not data — emit it as a plain line
  // so it does not masquerade as a headerless table.
  if (rows.length === 1) return rows[0]!.filter(Boolean).join(' ');

  const [header, ...body] = rows;
  return [pad(header!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(pad)].join('\n');
}
