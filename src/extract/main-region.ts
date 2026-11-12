// ─── Main content region ────────────────────────────────────────────────────
//
// Which part of a page is its content: the author's own <main> or <article>, else the cluster of
// paragraphs a Readability-style score picks, else <body>. html-to-markdown.ts reads from here.

import type { CheerioAPI, Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';

/** Regions that are page furniture, never content. */
export const CHROME_SELECTOR =
  'nav, header, footer, aside, script, style, noscript, template, svg, #comments, .comments, .comment-list, #disqus_thread, #respond';

/**
 * A form that collects input is page furniture. A form that wraps the whole page (the pattern some
 * server frameworks emit) holds the content, so it is kept: it has several paragraphs or headings,
 * or a long body of text.
 */
export function isInputForm($form: Cheerio<AnyNode>): boolean {
  return $form.find('p, h1, h2, h3').length < 3 && $form.text().length < 1500;
}

/**
 * The main-content root, in order of confidence:
 *
 *   1. The first `<main>` or `<article>` — the author told us, believe them.
 *   2. PARITY-READABILITY-1: on div-soup pages that never use
 *      semantic tags, score the content the Readability way — paragraphs
 *      vote for their parent — and take the winning cluster.
 *   3. `<body>`, when nothing scores — chrome stripping is then all we have.
 *
 * The change hash (extract/content-region-hash.ts) reads this same region, so
 * a change to any text the markdown shows changes the hash.
 */
export function selectMainRegion($: CheerioAPI): Cheerio<AnyNode> {
  const main = $('main').first();
  if (main.length > 0) return main as Cheerio<AnyNode>;
  // One article is the page's content. Several are a listing, and the first alone would drop the rest.
  if ($('article').length === 1) return $('article').first() as Cheerio<AnyNode>;
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
 *   - every other container holding >= 15% of the mass is kept with it, so two
 *     articles, or a post beside event blocks, are not reduced to the biggest;
 *   - fewer than 2 scoring paragraphs is no signal at all.
 */
function scoreContentParent($: CheerioAPI): Cheerio<AnyNode> | null {
  const scores = new Map<AnyNode, number>();
  let totalMass = 0;
  let scoringParagraphs = 0;

  $('p').each((_, p) => {
    const $p = $(p);
    // READABILITY-CHROME-1: a paragraph inside nav, header, footer or aside
    // does not vote, so a prose-heavy sidebar never outscores a short article.
    // The later chrome strip removes chrome inside the scope and cannot remove
    // a scope that sits inside chrome.
    if ($p.closest(CHROME_SELECTOR).length > 0) return;
    const $form = $p.closest('form');
    if ($form.length > 0 && isInputForm($form as Cheerio<AnyNode>)) return;

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

  // The winner and every container that holds a real share of the prose. A container that holds another kept
  // one is left out, because taking it would bring back everything around the content.
  const kept = [...scores].filter(([, score]) => score / totalMass >= 0.15).map(([node]) => node);
  const leaves = kept.filter((node) => !kept.some((other) => other !== node && $(other as never).parents().toArray().includes(node as never)));
  return $(leaves) as Cheerio<AnyNode>;
}
