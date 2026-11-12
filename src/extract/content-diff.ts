// ─── What changed, not just that something did ──────────────────────────────
//
// BETTER-DIFF-1: `unchanged` is a boolean. A consumer whose
// listing page gained ONE event re-extracts the whole page — and pays for the
// whole page — to discover that one row moved.
//
// Re-extraction is the dominant line item in a crawl pipeline, so handing over
// the delta is worth more than any saving on the fetch itself. We hold both
// versions; the consumer holds neither in a comparable form.
//
// Markdown makes this tractable in a way flat text never was: block
// boundaries are explicit, so "a new row appeared in that table" is a real
// unit and no shifted character offset.

export type ContentDiff = {
  changed: boolean;
  /** True when more blocks changed than the lists below report, or a reported block was cut to its first 400 characters. `changed` is exact either way. */
  truncated: boolean;
  added: string[];
  removed: string[];
};

const MAX_BLOCK_CHARS = 400;
/** The most changed blocks reported per side. The comparison itself covers every block. */
const MAX_REPORTED_BLOCKS = 2000;

/** Split markdown (or text) into comparable blocks: one per line, so each list item and table row is its own unit. */
function toBlocks(content: string): string[] {
  return content
    .split(/\n+/)
    .map((block) => block.trim())
    .filter(Boolean);
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
    else added.push(block);
  }

  // Whatever is left unconsumed was in the old version and is not in the new.
  const removed: string[] = [];
  for (const [block, remaining] of counts) {
    for (let i = 0; i < remaining; i++) removed.push(block);
  }

  const cut = [...added, ...removed].some((block) => block.length > MAX_BLOCK_CHARS);
  const truncated = cut || added.length > MAX_REPORTED_BLOCKS || removed.length > MAX_REPORTED_BLOCKS;
  const report = (blocks: string[]) => blocks.slice(0, MAX_REPORTED_BLOCKS).map((block) => block.slice(0, MAX_BLOCK_CHARS));
  const reportedAdded = report(added);
  const reportedRemoved = report(removed);
  return {
    changed: added.length > 0 || removed.length > 0,
    truncated,
    added: reportedAdded,
    removed: reportedRemoved,
  };
}
