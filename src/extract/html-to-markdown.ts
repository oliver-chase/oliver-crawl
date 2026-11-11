// ─── HTML to Markdown ───────────────────────────────────────────────────────
//
// VENDOR-PARITY-1: markdown is an ACCURACY lever, not a format choice. Plain
// text flattens a schedule table into unlabelled tokens; markdown keeps the
// columns, headings and link targets the page's author already encoded, which
// is the difference between an extractor reading and guessing.
//
// Scoped to the main content region, so nav, footers and cookie banners never
// reach the model — Firecrawl's `onlyMainContent`, using logic we already had
// and were spending only on a change hash.
//
// Hand-written rather than pulling in Turndown: the tag set that matters for
// extraction is small, and a dependency would need the same injection and
// ReDoS audit as everything else here.

import type { CheerioAPI, Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { CHROME_SELECTOR, isInputForm, selectMainRegion } from './main-region.js';

export { selectMainRegion };

/** Escape the characters that would otherwise be read as markdown syntax. */
function escapeInline(text: string): string {
  return text.replace(/([\\`*_[\]])/g, '\\$1');
}

function collapse(text: string): string {
  return text.replace(/[ \t\r\n]+/g, ' ');
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
  scope.find('form').each((_, form) => {
    if (isInputForm($(form) as Cheerio<AnyNode>)) $(form).remove();
  });

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

/** Elements that read as part of a sentence. Consecutive ones, with the text between them, form one paragraph. */
const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'code', 'em', 'i', 'img', 'mark', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u']);

function isInlineNode(el: AnyNode): boolean {
  return el.type === 'text' || (el.type === 'tag' && INLINE_TAGS.has((el as { name: string }).name.toLowerCase()));
}

/**
 * Renders a container's children. Text and inline elements that sit side by side are one paragraph,
 * so a sentence with bold text and a link inside a div stays whole. A run that holds only links or
 * images (a bare link list) keeps one block per item.
 */
function renderChildren($: CheerioAPI, node: Cheerio<AnyNode>, blocks: string[], ctx: Ctx): void {
  let run: AnyNode[] = [];
  const flush = () => {
    const pending = run;
    run = [];
    if (pending.length === 0) return;
    const meaningful = pending.filter((el) => el.type !== 'text' || $(el).text().trim() !== '');
    const onlyLinksOrImages = meaningful.every((el) => el.type === 'tag' && ['a', 'img'].includes((el as { name: string }).name.toLowerCase()));
    if (onlyLinksOrImages) {
      for (const el of meaningful) renderNode($, $(el) as Cheerio<AnyNode>, el, blocks, ctx);
      return;
    }
    const text = inlineNodes($, $(pending) as Cheerio<AnyNode>);
    if (text) blocks.push(text);
  };
  node.contents().each((_, el) => {
    if (isInlineNode(el)) {
      run.push(el);
      return;
    }
    flush();
    renderNode($, $(el) as Cheerio<AnyNode>, el, blocks, ctx);
  });
  flush();
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

    case 'p': {
      const text = inline($, $el);
      if (text) blocks.push(text);
      return;
    }

    case 'div':
    case 'section': {
      // A div is a layout box, not a semantic block, so recurse: nested headings, lists and tables
      // are still recognised rather than flattened.
      renderChildren($, $el, blocks, ctx);
      return;
    }

    case 'blockquote': {
      const inner: string[] = [];
      renderChildren($, $el, inner, ctx);
      if (inner.length) {
        blocks.push(
          inner
            .join('\n\n')
            .split('\n')
            .map((line) => (line ? `> ${line}` : '>'))
            .join('\n'),
        );
      }
      return;
    }

    case 'ul':
    case 'ol': {
      const lines = renderList($, $el, ctx.listDepth);
      if (lines.length) blocks.push(lines.join('\n'));
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

    case 'a': {
      // MARKDOWN-BLOCKLINK-1: a link that is a direct child of a
      // container rather than inside a paragraph. The `default` branch
      // recursed into its text and emitted the label with the href DROPPED,
      // so any site listing links as bare children of a div — search results,
      // index pages, link lists — produced markdown with no URLs at all.
      //
      // Same shape as the block-level <img> case below: the inline path knew
      // how to render these, and nothing routed block-level ones to it.
      //
      // Rendered from the anchor ITSELF, not via inline() — inline() walks an
      // element's CHILDREN, so handing it the <a> renders only the label and
      // drops the href, which is the bug this case exists to fix.
      const label = inline($, $el).trim();
      const href = $el.attr('href') || '';
      if (label) blocks.push(href ? `[${label}](${escapeHref(href)})` : label);
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

/** Parentheses and spaces in a URL would end a Markdown link early, so they are percent-encoded. */
function escapeHref(href: string): string {
  return href.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/** One list as lines, each nested list indented one level deeper than its item. */
function renderList($: CheerioAPI, $list: Cheerio<AnyNode>, depth: number): string[] {
  const ordered = (($list.get(0) as { name?: string } | undefined)?.name ?? '').toLowerCase() === 'ol';
  const lines: string[] = [];
  $list.children('li').each((index, li) => {
    const own = $(li).contents().filter((_, child) => !(child.type === 'tag' && ['ul', 'ol'].includes((child as { name: string }).name.toLowerCase())));
    const text = inlineNodes($, own as Cheerio<AnyNode>);
    const marker = ordered ? `${index + 1}.` : '-';
    if (text) lines.push(`${'  '.repeat(depth)}${marker} ${text}`);
    $(li)
      .children('ul, ol')
      .each((_, nested) => {
        lines.push(...renderList($, $(nested) as Cheerio<AnyNode>, depth + 1));
      });
  });
  return lines;
}

/**
 * Render one <img> as markdown. Shared by the block and inline paths.
 *
 * MARKDOWN-DATAURI-1 (found by scripts/parity-check.mjs on a live
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
  return inlineNodes($, $el.contents());
}

/** Inline-render a set of sibling nodes. */
function inlineNodes($: CheerioAPI, nodes: Cheerio<AnyNode>): string {
  const parts: string[] = [];

  nodes.each((_, node) => {
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
        parts.push(href ? `[${text}](${escapeHref(href)})` : text);
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
      case 'p':
      case 'div':
      case 'li':
      case 'blockquote':
        // Block elements inside inline text keep a space around them, so words do not fuse.
        parts.push(' ', inline($, $node), ' ');
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
