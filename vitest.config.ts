import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // A busy machine makes the first import in a hook take seconds, so the limits are generous. A test that hangs
    // still fails at 30 seconds.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
