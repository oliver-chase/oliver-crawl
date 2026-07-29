#!/usr/bin/env node
// Backlog-hygiene gate. A heading-level DONE marker is the check, not a
// line-count cap -- a cap failed a repo with a legitimately large, fully
// open-only backlog, where the marker check does not. OliverCode's own
// docs/DECISIONS.md records the reasoning behind that choice.
//
//   node scripts/check-backlog-hygiene.mjs [--quiet]
//
// Looks for docs/BACKLOG.md, then BACKLOG.md at the repo root. Neither present
// is not a violation — this gate has nothing to check, not a failure to report.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const QUIET = process.argv.includes('--quiet');
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const CANDIDATES = ['docs/BACKLOG.md', 'BACKLOG.md'];
const path = CANDIDATES.map((p) => join(ROOT, p)).find((p) => existsSync(p));

if (!path) {
  if (!QUIET) console.log('OK: no BACKLOG.md in this repo.');
  process.exit(0);
}

const text = readFileSync(path, 'utf8');
const lines = text.split('\n');
const relPath = CANDIDATES[[join(ROOT, CANDIDATES[0]), join(ROOT, CANDIDATES[1])].indexOf(path)];

// Heading lines only — "DONE" in a paragraph can be describing the work still
// needed to reach it, not announcing that a section is finished. A heading
// announcing it is the one place this fleet's own convention consistently
// used to mark a section safe to delete instead of deleting it.
//
// "not ... done" (in that order) negates the marker rather than setting it —
// "### Not done — genuine follow-on" is the opposite of finished, and a plain
// \bDONE\b test flagged it as a false positive on the repo this gate was
// written against.
const doneHeadings = [];
lines.forEach((line, i) => {
  if (!/^#{1,6}\s/.test(line)) return;
  if (!/\bDONE\b/i.test(line)) return;
  if (/\bnot\b.*\bdone\b/i.test(line)) return;
  doneHeadings.push({ n: i + 1, text: line.trim() });
});

if (!QUIET) {
  console.log('=== Backlog-hygiene check ===');
  console.log(`  ${relPath}: ${lines.length} lines (informational)`);
}

if (doneHeadings.length === 0) {
  console.log(`OK: no DONE-marked heading in ${relPath}.`);
  process.exit(0);
}

for (const h of doneHeadings) console.log(`  [DONE] ${relPath}:${h.n} ${h.text}`);
console.log('');
console.log(`FAIL: ${doneHeadings.length} heading(s) in ${relPath} mark a section DONE.`);
console.log('A finished section is removed, not ticked — git is the record of what shipped.');
console.log('Fold any surviving open item into the open-work list, then delete the section.');
process.exit(1);
