import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// scripts/check-imports.mjs fails the build on an import Node cannot resolve from dist: an alias, or a relative path with no .js.

const script = join(process.cwd(), 'scripts', 'check-imports.mjs');

function run(source: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'imports-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), source);
  copyFileSync(script, join(dir, 'check.mjs'));
  try {
    return { ok: true, output: execFileSync('node', ['check.mjs'], { cwd: dir, encoding: 'utf8' }) };
  } catch (error) {
    return { ok: false, output: String((error as { stderr?: string }).stderr ?? error) };
  }
}

describe('the import check', () => {
  test('passes imports that carry .js', () => {
    expect(run("import x from './fine.js';\nexport * from './also.js';\n").ok).toBe(true);
  });

  test.each([
    ["single-quoted from", "import x from './noext';"],
    ["double-quoted from", 'import x from "./noext";'],
    ["export star", 'export * from "./noext";'],
    ["bare side-effect import", "import './side';"],
    ["dynamic import", "const m = await import('./dyn');"],
    ["alias", "import x from '@/core/types';"],
  ])('fails %s', (_label, source) => {
    expect(run(source).ok).toBe(false);
  });
});
