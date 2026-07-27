import { describe, expect, test } from 'vitest';
import { urlDedupKey, sameUrlResource } from '@/core/url-dedup-key';

describe('urlDedupKey — collapses spellings of one resource', () => {
  const cases: Array<[string, string, string]> = [
    ['trailing slash', 'https://x.com/events', 'https://x.com/events/'],
    ['fragment', 'https://x.com/events', 'https://x.com/events#lineup'],
    ['scheme', 'http://x.com/events', 'https://x.com/events'],
    ['host case', 'https://X.COM/events', 'https://x.com/events'],
    ['default port', 'https://x.com:443/events', 'https://x.com/events'],
    ['utm params', 'https://x.com/events', 'https://x.com/events?utm_source=fb&utm_medium=social'],
    ['click ids', 'https://x.com/events', 'https://x.com/events?fbclid=abc&gclid=def'],
    ['param order', 'https://x.com/e?b=2&a=1', 'https://x.com/e?a=1&b=2'],
    ['tracking mixed with real', 'https://x.com/e?month=8', 'https://x.com/e?utm_source=fb&month=8'],
  ];

  for (const [name, a, b] of cases) {
    test(`${name} collapses`, () => expect(sameUrlResource(a, b)).toBe(true));
  }
});

describe('urlDedupKey — never merges genuinely different resources', () => {
  // A wrong merge means a real page is never crawled, and its absence is
  // invisible. These are the cases that must NOT collapse.
  const distinct: Array<[string, string, string]> = [
    ['different path', 'https://x.com/events', 'https://x.com/calendar'],
    ['different host', 'https://a.com/events', 'https://b.com/events'],
    ['subdomain', 'https://x.com/events', 'https://www.x.com/events'],
    ['non-default port', 'https://x.com:8080/events', 'https://x.com/events'],
    ['meaningful param value', 'https://x.com/cal?month=7', 'https://x.com/cal?month=8'],
    ['param presence', 'https://x.com/cal', 'https://x.com/cal?month=8'],
    // Ambiguous params some CMSs really route on — deliberately NOT stripped.
    ['ref param', 'https://x.com/e', 'https://x.com/e?ref=nav'],
    ['source param', 'https://x.com/e', 'https://x.com/e?source=partner'],
    ['deep path vs trailing segment', 'https://x.com/a/b', 'https://x.com/a'],
  ];

  for (const [name, a, b] of distinct) {
    test(`${name} stays distinct`, () => expect(sameUrlResource(a, b)).toBe(false));
  }
});

describe('urlDedupKey — degenerate input', () => {
  test('empty is empty and never matches', () => {
    expect(urlDedupKey('')).toBe('');
    expect(sameUrlResource('', '')).toBe(false);
  });

  test('an unparseable url still dedups against its twin', () => {
    expect(sameUrlResource('not a url/', 'NOT A URL')).toBe(true);
  });

  test('an unparseable url does not match a different one', () => {
    expect(sameUrlResource('not a url', 'other junk')).toBe(false);
  });
});
