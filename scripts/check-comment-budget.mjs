#!/usr/bin/env node
// Comment-budget gate — makes CODE_INTENT_STANDARD §1 mechanical. §1 was
// instruction text, and instruction text did not hold: a census found a fleet
// repo at 23% comment lines, 64 files carrying a block over 20.
//
// BLOCK LENGTH is fatal, density never is. High density in short comments beside
// the code they govern is defensible; a 65-line block is not, because the reader
// reaches the code with the explanation off-screen and never re-reads it when the
// code changes. Cap 20 is triple §1's ceiling, so it catches essays, not judgment.
//
//   node scripts/check-comment-budget.mjs [--max N] [--quiet] [--top N]
//
// Exemptions go in .comment-budget.json at the repo root, each with a `why`:
//   { "max": 20, "exempt": [ { "path": "src/x.ts", "why": "..." } ] }
// An unexplained exemption is the gate switched off one file at a time.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const QUIET = args.includes('--quiet');
const TOP = flag('--top', 15);

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

let config = { max: 20, exempt: [] };
const configPath = join(ROOT, '.comment-budget.json');
if (existsSync(configPath)) {
  config = { ...config, ...JSON.parse(readFileSync(configPath, 'utf8')) };
}
const MAX = flag('--max', config.max);
const exempt = new Map((config.exempt ?? []).map((e) => [e.path, e.why]));

const SOURCE = /\.(js|mjs|cjs|jsx|ts|tsx|py|sh|bash)$/;

const files = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && SOURCE.test(f) && !f.includes('node_modules'));

/** A JSDoc/docstring tag line. These are interface documentation — a function
 *  with twelve parameters has twelve @param lines and no essay. Counting them
 *  would push people to delete the useful part, so a tag line ends the prose run
 *  rather than extending it. */
const TAG_LINE = /^[*#\s]*@\w+/;

/** Longest run of consecutive PROSE comment lines. A blank line inside a block
 *  does not end it — splitting an essay with blank lines is not shortening it. */
function scan(text, hashStyle) {
  const lines = text.split('\n');
  let inBlock = false;
  let run = 0, runStart = 0, maxRun = 0, maxStart = 0, commentLines = 0;

  const close = () => {
    if (run > maxRun) { maxRun = run; maxStart = runStart; }
    run = 0;
  };

  lines.forEach((raw, i) => {
    const line = raw.trim();
    let isComment = false;

    if (hashStyle) {
      isComment = line.startsWith('#') && !line.startsWith('#!');
    } else if (inBlock) {
      isComment = true;
      if (line.includes('*/')) inBlock = false;
    } else if (line.startsWith('/*')) {
      // A new /* ... */ block starts a fresh run. A section banner sitting above
      // a function's own JSDoc is two comments, not one essay, and merging them
      // penalises correct structure. Blank lines still do NOT break a run, so an
      // essay cannot be split into passing chunks.
      close();
      isComment = true;
      if (!line.includes('*/')) inBlock = true;
    } else if (line.startsWith('//') || line.startsWith('*')) {
      isComment = true;
    }

    if (isComment) {
      commentLines++;
      if (TAG_LINE.test(line.replace(/^\/\*+|^\/\//, ''))) {
        close();
      } else {
        if (run === 0) runStart = i + 1;
        run++;
      }
    } else if (line !== '') {
      close();
    }
  });
  close();
  // Non-blank denominator. Counting blank lines understates density by roughly
  // half — a repo measured at 22% this way is 39% of the lines anyone reads.
  const nonBlank = lines.filter((l) => l.trim() !== '').length;
  return { maxRun, maxStart, commentLines, total: nonBlank };
}

// ─── Correspondence: does the comment describe the code beneath it? ─────────
//
// A comment can pass every length and density rule and still document a
// different function. Found by reading, never by a gate: a header describing
// "one silent refresh attempt on an expired JWT ... returns true when a new
// access token was stored" sat above a helper that hides a dropdown, 55 lines
// from the function it described.
//
// Two rules, both chosen because they are unambiguous. A prose checker would be
// a keyword list, which is the failure WRITING_PROCESS names directly.
const DECL = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/;
// Capitalised, and either opening the comment or following a sentence end. That
// is the JSDoc convention for a function's OWN return, and the capital is what
// separates it from a claim about something else. Matching the bare word anywhere
// gave a 100% false-positive rate on live code: "a destructive command returns a
// confirm card" describes the server, and "silently resolves to the default" is
// not a return claim at all.
const RETURN_CLAIM = /(?:^|[.!?]\s+)(?:Returns?|Resolves?)\s+(?:true|false|null|the\b|a\b|an\b)/;

/** A `return` carrying a value, as opposed to a bare early `return;`. */
const RETURNS_VALUE = /\breturn\s+[^;\s]/;

function correspondence(text, file) {
  const lines = text.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DECL.exec(lines[i]);
    if (!m) continue;
    const [, name, paramStr] = m;

    // The comment block directly above, if any.
    let start = i;
    while (start > 0 && /^\s*(\/\/|\*|\/\*)/.test(lines[start - 1])) start--;
    if (start === i) continue;
    const block = lines.slice(start, i).join('\n');

    // 1. @param names must exist in the signature. A renamed parameter leaves
    //    the old name documented, and the doc then describes a value nobody passes.
    const params = paramStr
      .split(',')
      .map((p) => p.trim().replace(/[:=].*$/, '').replace(/^\.\.\./, '').trim())
      .filter(Boolean);
    if (params.length > 0) {
      for (const pm of block.matchAll(/@param\s+(?:\{[^}]*\}\s*)?\[?([A-Za-z_$][\w$]*)/g)) {
        if (!params.includes(pm[1])) {
          found.push(`${file}:${start + 1}  @param ${pm[1]} is not a parameter of ${name}(${params.join(', ')})`);
        }
      }
    }

    // 2. A stated return value must exist. This is the FLOW-3 shape: the comment
    //    describes what it returns, the function below returns nothing.
    if (RETURN_CLAIM.test(block)) {
      let depth = 0, body = '', started = false;
      for (let j = i; j < lines.length && j < i + 400; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') { depth++; started = true; }
          else if (ch === '}') depth--;
        }
        body += lines[j] + '\n';
        if (started && depth === 0) break;
      }
      if (started && !RETURNS_VALUE.test(body)) {
        found.push(`${file}:${start + 1}  comment states a return value; ${name}() returns none`);
      }
    }
  }
  return found;
}

const rows = [];
const mismatches = [];
let totalLines = 0, totalComment = 0;

for (const f of files) {
  let text;
  try { text = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
  const r = scan(text, /\.(py|sh|bash)$/.test(f));
  totalLines += r.total;
  totalComment += r.commentLines;
  rows.push({ file: f, ...r });
  if (/\.(js|mjs|cjs|jsx|ts|tsx)$/.test(f) && !exempt.has(f)) {
    mismatches.push(...correspondence(text, f));
  }
}

const over = rows
  .filter((r) => r.maxRun > MAX && !exempt.has(r.file))
  .sort((a, b) => b.maxRun - a.maxRun);

const densityPct = totalLines ? (totalComment / totalLines) * 100 : 0;
const density = densityPct.toFixed(1);

// Advisory, never fatal. Density cannot tell a good comment from a bad one — a
// file of two-line decision records beside the code they govern reads high and
// is correct. What it does catch is the failure block length cannot see: many
// MEDIUM comments, each restating its own conclusion. Measured across this
// fleet, human-written working code sits near 12%; every repo where an agent
// had been over-explaining sat at 25% or above.
const DENSITY_WARN = flag('--max-density', config.maxDensity ?? 25);
const densityLine = densityPct > DENSITY_WARN
  ? `Density ${density}% — above the ${DENSITY_WARN}% guideline. Read for restated conclusions.`
  : `Density ${density}% (informational).`;

if (!QUIET) {
  console.log('=== Comment-budget check ===');
  console.log(`  files ${files.length}  non-blank ${totalLines}  comment ${totalComment} (${density}%)`);
  console.log(`  cap: ${MAX} consecutive comment lines${exempt.size ? `, ${exempt.size} exempt` : ''}\n`);
}

if (mismatches.length > 0) {
  for (const m of mismatches.slice(0, TOP)) console.log(`  [MISMATCH] ${m}`);
  if (mismatches.length > TOP) console.log(`  ... and ${mismatches.length - TOP} more`);
  console.log('');
}

if (over.length === 0 && mismatches.length === 0) {
  console.log(`OK: no comment block over ${MAX} lines. ${densityLine}`);
  process.exit(0);
}

if (over.length === 0) {
  console.log(`FAIL: ${mismatches.length} comment(s) describe code that is not beneath them.`);
  console.log('Move the comment to what it documents, or correct it. See CODE_INTENT_STANDARD §1.');
  process.exit(1);
}

for (const r of over.slice(0, TOP)) {
  console.log(`  [BLOCK ${r.maxRun}] ${r.file}:${r.maxStart}`);
}
if (over.length > TOP) console.log(`  ... and ${over.length - TOP} more`);
console.log('');
console.log(`FAIL: ${over.length} file(s) with a comment block over ${MAX} lines.`);
console.log('Keep the defect the comment prevents; move the narrative to DECISIONS.md');
console.log('behind an AREA-TOPIC-N id and point the comment at it. See CODE_INTENT_STANDARD §1.');
process.exit(1);
