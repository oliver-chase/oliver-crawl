import { describe, expect, test } from 'vitest';
import { parseRobots, MAX_HONORED_CRAWL_DELAY_MS } from '@/fetch/robots-check';

// ROBOTS-DELAY-1: reading robots.txt for permission and ignoring its pacing
// takes only the half of the file that suits us — and it is a common way to
// get blocked by a site that technically allowed you.

describe('Crawl-delay is read from robots.txt', () => {
  test('a delay in the matching group is returned in ms', () => {
    const r = parseRobots('User-agent: *\nCrawl-delay: 5\nAllow: /', 'mybot', '/events');
    expect(r.policy).toBe('allow');
    expect(r.crawlDelayMs).toBe(5000);
  });

  test('fractional seconds are supported', () => {
    expect(parseRobots('User-agent: *\nCrawl-delay: 0.5\nAllow: /', 'mybot', '/').crawlDelayMs).toBe(500);
  });

  test('our own group wins over the wildcard group', () => {
    const robots = 'User-agent: *\nCrawl-delay: 10\n\nUser-agent: mybot\nCrawl-delay: 2\nAllow: /';
    expect(parseRobots(robots, 'mybot', '/').crawlDelayMs).toBe(2000);
  });

  test('no Crawl-delay yields null, not zero', () => {
    // null means "the site said nothing"; 0 would mean "the site said go fast".
    expect(parseRobots('User-agent: *\nAllow: /', 'mybot', '/').crawlDelayMs).toBeNull();
  });

  test('a delay is reported even when the path is disallowed', () => {
    const r = parseRobots('User-agent: *\nCrawl-delay: 3\nDisallow: /private', 'mybot', '/private');
    expect(r.policy).toBe('disallow');
    expect(r.crawlDelayMs).toBe(3000);
  });
});

describe('an absurd Crawl-delay cannot stall the crawler', () => {
  test('a one-day delay is capped', () => {
    // Sites really do publish Crawl-delay: 86400. Honouring it literally would
    // hang a crawl rather than slow it politely.
    const r = parseRobots('User-agent: *\nCrawl-delay: 86400\nAllow: /', 'mybot', '/');
    expect(r.crawlDelayMs).toBe(MAX_HONORED_CRAWL_DELAY_MS);
  });

  test('garbage and negative values are ignored', () => {
    expect(parseRobots('User-agent: *\nCrawl-delay: soon\nAllow: /', 'mybot', '/').crawlDelayMs).toBeNull();
    expect(parseRobots('User-agent: *\nCrawl-delay: -5\nAllow: /', 'mybot', '/').crawlDelayMs).toBeNull();
  });
});

describe('reasons never name another project’s crawler', () => {
  // WHITE-LABEL-2: these strings are returned to consumers. A generic package
  // reporting "FallowBot" is simply wrong output in any other repo.
  test('no hardcoded bot name in any reason string', () => {
    const results = [
      parseRobots('User-agent: *\nAllow: /', 'mybot', '/'),
      parseRobots('User-agent: *\nDisallow: /x', 'mybot', '/x'),
      parseRobots('User-agent: other\nDisallow: /', 'mybot', '/'),
      parseRobots('', 'mybot', '/'),
    ];
    for (const r of results) expect(r.reason.toLowerCase()).not.toContain('fallow');
  });
});
