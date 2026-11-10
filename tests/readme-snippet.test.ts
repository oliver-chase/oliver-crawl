import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import ts from 'typescript';
import * as library from '@/index';

// The first crawl in the README is what a new user pastes. It runs here against a stubbed network, so a change
// to the API that breaks the snippet fails the suite.

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('the README first crawl runs and returns Markdown', async () => {
  const section = README.slice(README.indexOf('## First crawl'));
  const block = section.match(/```typescript\n([\s\S]*?)```/)?.[1];
  if (!block) throw new Error('README has no first-crawl snippet');

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('dns-query')) {
      return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] }), { status: 200 });
    }
    return new Response('<html><head><title>Example</title></head><body><main><p>Example page content for the snippet.</p></main></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }) as typeof fetch;

  const body = block.replace(/import \{[^}]*\} from '@oliver\/crawl-core';\n/, '');
  const js = ts.transpileModule(`${body}\nreturn result;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<any>;
  const logged: unknown[] = [];
  const run = new AsyncFunction('createCrawler', 'console', js.replace(/^"use strict";?\n?/, ''));
  const result = await run(library.createCrawler, { log: (...a: unknown[]) => logged.push(...a) });

  expect(result.ok).toBe(true);
  expect(String(logged[0])).toContain('Example page content');
});
