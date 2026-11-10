import { afterEach, vi } from 'vitest';

// Every test file starts from the same state: the real fetch, empty caches, real timers and no leftover mocks.
// The modules are imported inside the hook, after a test file's own imports and mocks have been applied.
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  (await import('@/fetch/host-policy')).__clearDnsCacheForTests?.();
  (await import('@/core/page-cache')).__clearPageCacheForTests();
  (await import('@/core/host-throttle')).__clearThrottleForTests();
  (await import('@/lanes/own/index')).__clearRobotsCacheForTests();
  (await import('@/core/config')).__clearUserAgentWarningsForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
