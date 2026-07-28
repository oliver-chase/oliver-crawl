#!/usr/bin/env node
// ─── Decision-record integrity gate ─────────────────────────────────────────
//
// This codebase records WHY in the code, naming the defect a decision prevents
// — MARKDOWN-DATAURI-1, ROBOTS-4XX-1, and so on. That only stays durable if the
// records stay honest, and three things rot quietly without a check: a decision
// written down but never tested, so the next refactor undoes it and nothing goes
// red; a decision deleted from the code whose test and docs keep describing it;
// and an ID invented in a test or doc that no code ever referenced, which reads
// as authoritative and is fiction.
//
// This fails the build on each instead of letting them age into folklore.
// Deliberately mechanical: it checks the records line up, never that the
// reasoning is good.
//
//   node scripts/check-decisions.mjs
//   node scripts/check-decisions.mjs --list   # what is recorded, and where

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ID_PATTERN = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+-\d+[a-z]?\b/g;

/**
 * Strings that look like decision IDs but are not. Charset names and RFC
 * numbers share the shape, and treating them as records would produce noise
 * that trains a reader to ignore this gate.
 */
const NOT_DECISIONS = new Set(['ISO-8859-1', 'ISO-8859-15', 'UTF-8', 'RFC-9309']);

const LEDGER = 'docs/DECISIONS.md';

function walk(dir, exts) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.includes(extname(full))) out.push(full);
  }
  return out;
}

function idsIn(files) {
  const found = new Map(); // id -> Set(file)
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.match(ID_PATTERN) ?? []) {
      if (NOT_DECISIONS.has(match)) continue;
      if (!found.has(match)) found.set(match, new Set());
      found.get(match).add(file);
    }
  }
  return found;
}

const srcIds = idsIn(walk('src', ['.ts']));
const testIds = idsIn(walk('tests', ['.ts']));
const ledgerIds = idsIn([LEDGER]);

if (process.argv.includes('--list')) {
  const all = [...new Set([...srcIds.keys(), ...testIds.keys(), ...ledgerIds.keys()])].sort();
  for (const id of all) {
    const where = [srcIds.has(id) && 'src', testIds.has(id) && 'test', ledgerIds.has(id) && 'ledger']
      .filter(Boolean)
      .join(',');
    console.log(`${id.padEnd(26)} ${where}`);
  }
  process.exit(0);
}

const problems = [];

// 1. Every decision in the code is written down. A decision nobody can find
//    is a decision the next reader will undo.
for (const [id, files] of srcIds) {
  if (!ledgerIds.has(id)) {
    problems.push(`${id} is referenced in ${[...files][0]} but has no entry in ${LEDGER}`);
  }
}

// 2. Every decision in the ledger still exists IN THE CODE.
//
//    This required `src/` specifically. Accepting "src OR tests" let a
//    surviving test launder a decision that had been renamed or deleted out of
//    the source — the exact refactor this gate exists to catch. Two entries
//    were already in that state when it was tightened.
for (const [id] of ledgerIds) {
  if (!srcIds.has(id)) {
    const where = testIds.has(id) ? 'only in tests/' : 'nowhere in the repo';
    problems.push(`${id} is recorded in ${LEDGER} but appears ${where} — not in src/`);
  }
}

// 2b. The ledger's Source column has to name a file that exists. A row
//     pointing at a moved or deleted file reads as authoritative and sends the
//     next reader somewhere empty.
const ledgerText = readFileSync(LEDGER, 'utf8');
for (const line of ledgerText.split('\n')) {
  const row = line.match(/^\|\s*`([A-Z][A-Z0-9-]*-\d+[a-z]?)`\s*\|[^|]*\|\s*`([^`]+)`\s*\|/);
  if (!row) continue;
  const [, id, srcPath] = row;
  const full = srcPath.startsWith('src/') ? srcPath : `src/${srcPath}`;
  if (!existsSync(full)) {
    problems.push(`${id}: ledger Source column names ${full}, which does not exist`);
  }
}

// 3. No test invents an ID. A test naming a record that never existed reads
//    as authoritative and is not.
for (const [id, files] of testIds) {
  if (!srcIds.has(id) && !ledgerIds.has(id)) {
    problems.push(`${id} appears in ${[...files][0]} but in neither src/ nor ${LEDGER}`);
  }
}

const untested = [...srcIds.keys()].filter((id) => !testIds.has(id)).sort();

console.log(`\nDECISION RECORDS — ${srcIds.size} in src, ${testIds.size} in tests, ${ledgerIds.size} in the ledger\n`);

if (untested.length > 0) {
  // Reported, not fatal. Some decisions are structural (a build flag, a
  // packaging choice) and have nothing a unit test can hold onto. Making this
  // fail the build would train people to add hollow tests.
  console.log(`  ${untested.length} decisions with no test naming them:`);
  for (const id of untested) console.log(`    - ${id}`);
  console.log('');
}

if (problems.length > 0) {
  console.log(`  ${problems.length} integrity problems:\n`);
  for (const p of problems) console.log(`    FAIL: ${p}`);
  console.log('');
  process.exit(1);
}

console.log('  Records are consistent: every decision in the code is written down,');
console.log('  every entry still describes live code, and no test invents one.\n');
