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
    expect(readPageCache('https://a.example.com/x', undefined, 60_000, 'with-credentials')).toEqual(success);
  });

  test('replays a success inside its lifetime and nothing when the lifetime is zero', () => {
    writePageCache('https://a.example.com/x', undefined, 60_000, success, 'v');
    expect(readPageCache('https://a.example.com/x', undefined, 60_000, 'v')).toEqual(success);
    writePageCache('https://a.example.com/y', undefined, 0, success, 'v');
    expect(readPageCache('https://a.example.com/y', undefined, 60_000, 'v')).toBeNull();
  });
});

describe('a cache hit is a copy', () => {
  test('editing one hit does not change the next', () => {
    const result = { ok: true as const, pages: [{ url: 'https://c.example.com/x', text: 'original' }] } as unknown as CrawlResult;
    writePageCache('https://c.example.com/x', undefined, 60_000, result, 'copy');
    const first = readPageCache('https://c.example.com/x', undefined, 60_000, 'copy') as typeof result & { pages: { text: string }[] };
    first.pages[0]!.text = 'edited';
    const second = readPageCache('https://c.example.com/x', undefined, 60_000, 'copy') as typeof first;
    expect(second.pages[0]!.text).toBe('original');
  });
});
