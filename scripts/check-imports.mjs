// Path aliases (@/...) are a COMPILE-TIME convenience: tsc emits them
// literally, so an aliased import in src/ produces a dist/ file Node cannot
// resolve. Caught in real adoption testing (a git-installed consumer crashed
// on `Cannot find package '@/core'`). This fails the build instead.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const bad = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith('.ts')) {
      readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
        if (/from '@\//.test(line)) bad.push(`${full}:${i + 1} alias import (tsc will not rewrite it)`);
        const rel = line.match(/from '(\.\.?\/[^']*)'/);
        if (rel && !rel[1].endsWith('.js')) bad.push(`${full}:${i + 1} relative import missing .js extension`);
      });
    }
  }
}
walk('src');
if (bad.length) {
  console.error('Import check FAILED:\n' + bad.map((b) => '  ' + b).join('\n'));
  process.exit(1);
}
console.log('Import check passed: no alias imports, all relative imports carry .js');
