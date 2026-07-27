// ─── What changed, not just that something did ──────────────────────────────
//
// BETTER-DIFF-1 (2026-07-27): `unchanged` is a boolean. A consumer whose
// listing page gained ONE event re-extracts the whole page — and pays for the
// whole page — to discover that one row moved.
//
// Re-extraction is the dominant line item in a crawl pipeline, so handing over
// the delta is worth more than any saving on the fetch itself. We hold both
// versions; the consumer holds neither in a comparable form.
//
// Markdown makes this tractable in a way flat text never was: block
// boundaries are explicit, so "a new row appeared in that table" is a real
// unit rather than a shifted character offset.

/** A block that appeared or disappeared between two versions. */
export type ContentChange = {
  kind: 'added' | 'removed';
  /** The block itself, truncated for reporting. */
  text: string;
};

export type ContentDiff = {
  changed: boolean;
  added: string[];
  removed: string[];
  /** Added and removed together, in that order, for simple iteration. */
  changes: ContentChange[];
};

const MAX_BLOCK_CHARS = 400;
/** Bound the work: a pathological pair of documents must not hang a crawl. */
const MAX_BLOCKS = 2000;

/** Split markdown (or text) into comparable blocks. */
function toBlocks(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .slice(0, MAX_BLOCKS);
}

/**
 * Compare two versions of a page's content.
 *
 * Set-based on purpose, not a line-by-line diff: a listing page that inserts a
 * new event at the top shifts every subsequent line, and a positional diff
 * would report the entire page as changed. What a consumer actually needs is
 * "these blocks are new" — reordering is not a content change.
 *
 * Duplicate blocks are handled by count, so a page that legitimately repeats a
 * line twice and now repeats it three times reports one addition.
 */
export function diffContent(previous: string, current: string): ContentDiff {
  const before = toBlocks(previous);
  const after = toBlocks(current);

  const counts = new Map<string, number>();
  for (const block of before) counts.set(block, (counts.get(block) ?? 0) + 1);

  const added: string[] = [];
  for (const block of after) {
    const remaining = counts.get(block) ?? 0;
    if (remaining > 0) counts.set(block, remaining - 1);
    else added.push(block.slice(0, MAX_BLOCK_CHARS));
  }

  // Whatever is left unconsumed was in the old version and is not in the new.
  const removed: string[] = [];
  for (const [block, remaining] of counts) {
    for (let i = 0; i < remaining; i++) removed.push(block.slice(0, MAX_BLOCK_CHARS));
  }

  return {
    changed: added.length > 0 || removed.length > 0,
    added,
    removed,
    changes: [
      ...added.map((text): ContentChange => ({ kind: 'added', text })),
      ...removed.map((text): ContentChange => ({ kind: 'removed', text })),
    ],
  };
}
