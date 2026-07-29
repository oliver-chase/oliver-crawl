#!/usr/bin/env node
// Decision-record integrity gate.
//
// A codebase records WHY in the code, naming the defect a decision prevents.
// Three things rot quietly without a check: a decision deleted from the code
// whose ledger row keeps describing it, an id invented in a test that no code
// ever referenced, and a decision in the code that nobody wrote down — which the
// next reader simply undoes.
//
// Adoption is the hard part, not detection. A repo turning this on with hundreds
// of undocumented ids cannot fix them in one pass, and a gate that fails a
// thousand times on day one gets switched off. So unrecorded ids present at
// adoption are frozen into a baseline and pass; anything NEW fails. Debt only
// shrinks. Delete a line from the baseline once its row is written; never add one.
//
//   node scripts/check-decisions.mjs
//   node scripts/check-decisions.mjs --list        # every id and where it lives
//   node scripts/check-decisions.mjs --write-baseline
//
// Config lives in .decisions.json at the repo root. See CODE_INTENT_STANDARD §4.

import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname, relative, resolve } from 'node:path';

// This file names example ids in its own comments, and it usually lives in a
// scanned directory, so without excluding itself it reports them as undocumented
// decisions. The reachability checker in OliverCode hit the same trap the other
// way round, satisfying its own rule.
const SELF = relative(process.cwd(), resolve(process.argv[1] ?? ''));

// AREA-TOPIC-N per CODE_INTENT_STANDARD §2: three segments, so at least two
// dashes. An earlier cut made the middle segment optional and matched every
// two-segment label in the fleet — BUG-9, BC-1, EPIC-2, US-SDR-202 — which are
// test cases and user stories, not decision records. That noise was worked
// around with exclusion lists before the pattern itself was the problem.
const ID_PATTERN = /\b[A-Z][A-Z0-9]+(?:-[A-Z0-9]{2,})+-\d+[a-z]?\b/g;

const DEFAULTS = {
  sourceDirs: ['src'],
  testDirs: ['tests'],
  extensions: ['.ts', '.tsx', '.js', '.mjs', '.py'],
  ledger: 'docs/DECISIONS.md',
  docDirs: ['docs'],
  baseline: 'scripts/decisions-baseline.txt',
  // Charset names, RFC numbers and HTTP dates share the id shape. Treating them
  // as records produces noise that trains a reader to ignore the gate.
  notDecisions: ['ISO-8859-1', 'ISO-8859-15', 'UTF-8', 'RFC-9309'],
  // A whole AREA that never names decisions. User stories (US-TSK-118,
  // US-SDR-202) match the id shape exactly and are work items, not records —
  // demanding a ledger row for each would fill the ledger with the backlog.
  // Listing the area rather than the ids means a new story needs no config edit.
  notDecisionAreas: ['US'],
};

function loadConfig() {
  if (!existsSync('.decisions.json')) return { ...DEFAULTS };
  let raw;
  try {
    raw = JSON.parse(readFileSync('.decisions.json', 'utf8'));
  } catch (err) {
    console.error(`.decisions.json is not valid JSON: ${err.message}`);
    process.exit(2);
  }
  for (const key of ['sourceDirs', 'testDirs', 'docDirs', 'extensions', 'notDecisions', 'notDecisionAreas']) {
    if (key in raw && !Array.isArray(raw[key])) {
      console.error(`.decisions.json: ${key} must be an array`);
      process.exit(2);
    }
  }
  return { ...DEFAULTS, ...raw };
}

const cfg = loadConfig();
const NOT_DECISIONS = new Set(cfg.notDecisions);
const NOT_DECISION_AREAS = new Set(cfg.notDecisionAreas);

function walk(dir, exts = cfg.extensions) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.includes(extname(full)) && full !== SELF) out.push(full);
  }
  return out;
}

/** Ids on a line, ignoring any inside a quoted string. */
function idsOnLine(line) {
  const spans = [...line.matchAll(/'[^']*'|"[^"]*"/g)].map((m) => [m.index, m.index + m[0].length]);
  const out = [];
  for (const m of line.matchAll(ID_PATTERN)) {
    if (NOT_DECISIONS.has(m[0])) continue;
    if (NOT_DECISION_AREAS.has(m[0].split('-')[0])) continue;
    if (spans.some(([a, b]) => a < m.index && m.index + m[0].length <= b)) continue;
    // A regex character class reads as an id: /[A-Z0-9]/ yields "Z0-9". No real id
    // is written immediately before a `]`.
    if (line[m.index + m[0].length] === ']') continue;
    out.push(m[0]);
  }
  return out;
}

function idsIn(files) {
  const found = new Map();
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      for (const id of idsOnLine(line)) {
        if (!found.has(id)) found.set(id, new Set());
        found.get(id).add(file);
      }
    }
  }
  return found;
}

const srcIds = idsIn(cfg.sourceDirs.flatMap((d) => walk(d)));
const testIds = idsIn(cfg.testDirs.flatMap((d) => walk(d)));
const ledgerIds = existsSync(cfg.ledger) ? idsIn([cfg.ledger]) : new Map();
// Docs are scanned for markdown only, and only to answer "does this id exist at all".
const docIds = idsIn(cfg.docDirs.flatMap((d) => walk(d, ['.md'])));

if (process.argv.includes('--list')) {
  const all = [...new Set([...srcIds.keys(), ...testIds.keys(), ...ledgerIds.keys()])].sort();
  for (const id of all) {
    const where = [srcIds.has(id) && 'src', testIds.has(id) && 'test', ledgerIds.has(id) && 'ledger']
      .filter(Boolean)
      .join(',');
    console.log(`${id.padEnd(28)} ${where}`);
  }
  process.exit(0);
}

const unrecorded = [...srcIds.keys()].filter((id) => !ledgerIds.has(id)).sort();

if (process.argv.includes('--write-baseline')) {
  const body =
    '# Decision ids present in the code with no ledger row, frozen at adoption.\n' +
    '# Delete a line once its row is written. Never add one: a new id needs a row.\n' +
    unrecorded.map((id) => `${id}\n`).join('');
  writeFileSync(cfg.baseline, body);
  console.log(`wrote ${cfg.baseline} with ${unrecorded.length} accepted id(s)`);
  process.exit(0);
}

const accepted = new Set(
  existsSync(cfg.baseline)
    ? readFileSync(cfg.baseline, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
    : [],
);

const problems = [];

// A decision nobody can find is one the next reader will undo. Baselined ids are
// the debt this repo adopted with; a NEW one has to be written down.
for (const id of unrecorded) {
  if (!accepted.has(id)) {
    problems.push(`${id} is referenced in ${[...srcIds.get(id)][0]} but has no entry in ${cfg.ledger}`);
  }
}

// A row describing deleted code is worse than no row, because it is confidently
// wrong. Source specifically: accepting "source OR tests" lets a surviving test
// launder a decision that was renamed or deleted out of the source.
for (const id of ledgerIds.keys()) {
  if (!srcIds.has(id)) {
    problems.push(
      `${id} is recorded in ${cfg.ledger} but appears ${testIds.has(id) ? 'only in tests' : 'nowhere in the code'}`,
    );
  }
}

// A test naming a record that exists nowhere else reads as authoritative. Reported,
// never fatal: a test may name an id whose code is specced but not yet built, and
// failing there pushes people to delete the reference rather than build the thing.
// Docs therefore count as somewhere the id can exist.
const inventedIds = [...testIds]
  .filter(([id]) => !srcIds.has(id) && !ledgerIds.has(id) && !docIds.has(id))
  .map(([id, files]) => `${id} (${[...files][0]})`)
  .sort();

// Every check above reads the ledger through ID_PATTERN, so a row whose id does
// not match it is invisible to all of them: the id in the source is never seen as
// recorded, and the row outlives the code it describes. The row reads as governed
// and is not. The framework's own ledger carried one from the day it was written
// — two segments where §2 requires three — and nothing could report it.
//
// A ledger row may also name its source file in a third column. Where it does,
// that file has to exist: a row pointing at moved or deleted code sends the next
// reader somewhere empty while reading as authoritative. Ledgers without the
// column are unaffected, since nothing matches.
const ID_SHAPE = new RegExp(`^${ID_PATTERN.source}$`);

if (existsSync(cfg.ledger)) {
  for (const line of readFileSync(cfg.ledger, 'utf8').split('\n')) {
    const first = line.match(/^\|\s*`([^`]+)`\s*\|/);
    if (!first) continue;
    const id = first[1];
    if (!ID_SHAPE.test(id)) {
      problems.push(`${id}: ledger row id is not AREA-TOPIC-N, so no check can read it (CODE_INTENT_STANDARD §2)`);
      continue;
    }
    const withSource = line.match(/^\|\s*`[^`]+`\s*\|[^|]*\|\s*`([^`]+)`\s*\|/);
    if (!withSource) continue;
    const srcPath = withSource[1];
    const found = existsSync(srcPath) || cfg.sourceDirs.some((d) => existsSync(join(d, srcPath)));
    if (!found) problems.push(`${id}: ledger names ${srcPath}, which does not exist`);
  }
}

const stale = [...accepted].filter((id) => !srcIds.has(id) || ledgerIds.has(id)).sort();

console.log(
  `\nDECISION RECORDS — ${srcIds.size} in source, ${testIds.size} in tests, ${ledgerIds.size} in the ledger`,
);
if (accepted.size > 0) console.log(`  ${accepted.size} baselined as undocumented debt`);

if (inventedIds.length > 0) {
  console.log(`\n  ${inventedIds.length} id(s) named only by a test — a label, or a record nobody wrote:`);
  for (const i of inventedIds) console.log(`    - ${i}`);
}

if (stale.length > 0) {
  // Reported, not fatal. A baseline line whose id is now documented or gone is
  // dead weight, but failing on it would block the very commit that fixed it.
  console.log(`\n  ${stale.length} baseline line(s) no longer needed — delete them:`);
  for (const id of stale) console.log(`    - ${id}`);
}

if (problems.length > 0) {
  console.log(`\n  ${problems.length} integrity problem(s):\n`);
  for (const p of problems) console.log(`    FAIL: ${p}`);
  console.log('');
  process.exit(1);
}

console.log('  Records are consistent: no new undocumented decision, no row describing');
console.log('  code that is gone, and no test inventing an id.\n');
