import { afterEach, describe, expect, test } from 'vitest';
import { __clearPageCacheForTests, readPageCache, writePageCache } from '@/core/page-cache';
import type { CrawlResult } from '@/core/types';

// Only a full success is replayed. A failure may be transient and a 304 depends on the validators the
// first caller sent, so neither is cached.

afterEach(() => __clearPageCacheForTests());

const failure = { ok: false, reason: 'unreachable', detail: 'down', lane: 'own' } as unknown as CrawlResult;
const notModified = { ok: true, notModified: true, lane: 'own' } as unknown as CrawlResult;
const success = { ok: true, notModified: false, pages: [], lane: 'own' } as unknown as CrawlResult;

describe('writePageCache', () => {
  test('does not cache a failure', () => {
    writePageCache('https://a.example.com/x', undefined, 60_000, failure, 'v');
    expect(readPageCache('https://a.example.com/x', undefined, 60_000, 'v')).toBeNull();
  });

  test('does not cache a 304', () => {
    writePageCache('https://a.example.com/x', undefined, 60_000, notModified, 'v');
    expect(readPageCache('https://a.example.com/x', undefined, 60_000, 'v')).toBeNull();
  });

  test('a different variant is a different entry', () => {
    writePageCache('https://a.example.com/x', undefined, 60_000, success, 'with-credentials');
    expect(readPageCache('https://a.example.com/x', undefined, 60_000, 'anonymous')).toBeNull();
    expect(readPageCache('https://a.example.com/x', undefined, 60_000, 'with-credentials')).toBe(success);
  });

  test('replays a success inside its lifetime and nothing when the lifetime is zero', () => {
    writePageCache('https://a.example.com/x', undefined, 60_000, success, 'v');
    expect(readPageCache('https://a.example.com/x', undefined, 60_000, 'v')).toBe(success);
    writePageCache('https://a.example.com/y', undefined, 0, success, 'v');
    expect(readPageCache('https://a.example.com/y', undefined, 60_000, 'v')).toBeNull();
  });
});
