import { describe, expect, test } from 'vitest';
import { urlDedupKey, sameUrlResource } from '@/core/url-dedup-key';

describe('urlDedupKey — collapses spellings of one resource', () => {
  const cases: Array<[string, string, string]> = [
    ['trailing slash', 'https://site.example.com/events', 'https://site.example.com/events/'],
    ['fragment', 'https://site.example.com/events', 'https://site.example.com/events#lineup'],
    ['scheme', 'http://site.example.com/events', 'https://site.example.com/events'],
    ['host case', 'https://SITE.EXAMPLE.COM/events', 'https://site.example.com/events'],
    ['default port', 'https://site.example.com:443/events', 'https://site.example.com/events'],
    ['utm params', 'https://site.example.com/events', 'https://site.example.com/events?utm_source=fb&utm_medium=social'],
    ['click ids', 'https://site.example.com/events', 'https://site.example.com/events?fbclid=abc&gclid=def'],
    ['param order', 'https://site.example.com/e?b=2&a=1', 'https://site.example.com/e?a=1&b=2'],
    ['tracking mixed with real', 'https://site.example.com/e?month=8', 'https://site.example.com/e?utm_source=fb&month=8'],
  ];

  for (const [name, a, b] of cases) {
    test(`${name} collapses`, () => expect(sameUrlResource(a, b)).toBe(true));
  }
});

describe('urlDedupKey — never merges genuinely different resources', () => {
  // A wrong merge means a real page is never crawled, and its absence is
  // invisible. These are the cases that must NOT collapse.
  const distinct: Array<[string, string, string]> = [
    ['different path', 'https://site.example.com/events', 'https://site.example.com/calendar'],
    ['different host', 'https://a.com/events', 'https://b.com/events'],
    ['subdomain', 'https://site.example.com/events', 'https://www.site.example.com/events'],
    ['non-default port', 'https://site.example.com:8080/events', 'https://site.example.com/events'],
    ['meaningful param value', 'https://site.example.com/cal?month=7', 'https://site.example.com/cal?month=8'],
    ['param presence', 'https://site.example.com/cal', 'https://site.example.com/cal?month=8'],
    // Ambiguous params some CMSs really route on — deliberately NOT stripped.
    ['ref param', 'https://site.example.com/e', 'https://site.example.com/e?ref=nav'],
    ['source param', 'https://site.example.com/e', 'https://site.example.com/e?source=partner'],
    ['deep path vs trailing segment', 'https://site.example.com/a/b', 'https://site.example.com/a'],
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
