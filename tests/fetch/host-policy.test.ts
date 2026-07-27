import { describe, expect, test } from 'vitest';
import {
  assertHostResolvesToPublicAddress,
  assertTargetEligible,
  assertRequestUrlAllowed,
  assertRedirectUrlAllowed,
  assertRedirectUrlAllowedForHost,
} from '@/fetch/host-policy';
import type { CrawlTarget } from '@/core/types';

// CRAWL-C5 (2026-07-27): this module is the SSRF / DNS-rebinding guard for
// the entire crawl stack — every fetch the crawler makes passes through it —
// and it was the ONLY generic crawl module with no direct test file. These
// tests exist both to lock the security behavior down and as the
// prerequisite for extracting the module into a shared crawl package
// (docs/CRAWL_EXTRACTION_SPEC.md): a security primitive must not move
// repos on trust alone.
//
// The DNS lookup is injectable (lookupFn), so the rebinding cases below are
// exercised against a stub rather than the network — deterministic, offline,
// and able to express answers a real resolver would rarely hand back.

function makeSource(overrides: Partial<CrawlTarget> = {}): CrawlTarget {
  return {
    name: 'Test Venue',
    baseUrl: 'https://venue.example.com',
    robotsPolicy: 'allow',
    active: true,
    ...overrides,
  };
}

const lookupTo = (address: string, family = 4) => async () => [{ address, family }];

describe('assertHostResolvesToPublicAddress — DNS rebinding defence', () => {
  // The core SSRF case: a hostname that LOOKS public but resolves inward.
  // Hostnames are unique per test — the module memoizes safe hosts, so a
  // shared name would let one case's cached verdict mask another's.
  test.each([
    ['loopback', '127.0.0.1'],
    ['private 10/8', '10.0.0.5'],
    ['private 192.168/16', '192.168.1.10'],
    ['private 172.16/12', '172.20.10.4'],
    ['carrier-grade NAT 100.64/10', '100.100.0.1'],
    ['benchmarking 198.18/15', '198.18.0.1'],
    ['this-network 0/8', '0.0.0.0'],
    ['multicast/reserved 224+', '239.1.2.3'],
  ])('blocks a public hostname that resolves to %s', async (label, address) => {
    const host = `rebind-${label.replace(/[^a-z0-9]/gi, '')}.example.com`;
    await expect(assertHostResolvesToPublicAddress(host, lookupTo(address))).rejects.toThrow(/private IPv4/i);
  });

  // AWS/GCP/Azure instance metadata — the highest-value SSRF target there is.
  test('blocks the cloud metadata address (169.254.169.254)', async () => {
    await expect(
      assertHostResolvesToPublicAddress('metadata-rebind.example.com', lookupTo('169.254.169.254')),
    ).rejects.toThrow(/private IPv4/i);
  });

  test('blocks IPv6 loopback', async () => {
    await expect(
      assertHostResolvesToPublicAddress('v6-loopback.example.com', lookupTo('::1', 6)),
    ).rejects.toThrow(/private IPv6/i);
  });

  // Blocked, but via the "invalid address" path rather than the private-IPv6
  // path — worth pinning precisely, because the REASON is a latent quirk:
  // isPrivateIpv6() has an explicit `::ffff:` branch that maps to the IPv4
  // check, but getIpVersion() rejects any address containing a '.' first, so
  // that branch is unreachable dead code. The security outcome is correct
  // either way (it fails CLOSED — both private AND public IPv4-mapped forms
  // are refused), which is why this asserts the real behavior instead of the
  // intended-looking one. Deliberately NOT "fixed" by teaching the parser to
  // accept ::ffff: forms: that would loosen input handling in an SSRF guard
  // to reach a branch that buys no additional protection.
  test('blocks IPv4-mapped IPv6 (fails closed, via the invalid-address path)', async () => {
    await expect(
      assertHostResolvesToPublicAddress('v6-mapped.example.com', lookupTo('::ffff:10.0.0.1', 6)),
    ).rejects.toThrow(/invalid address/i);
  });

  // A multi-record answer where only ONE entry is internal must still be
  // rejected — checking just the first record would be exploitable.
  test('blocks when ANY returned record is private, not just the first', async () => {
    const lookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.1.2.3', family: 4 },
    ];
    await expect(assertHostResolvesToPublicAddress('mixed-records.example.com', lookup)).rejects.toThrow(/private IPv4/i);
  });

  test('allows a genuinely public address', async () => {
    await expect(
      assertHostResolvesToPublicAddress('public-ok.example.com', lookupTo('93.184.216.34')),
    ).resolves.toBeUndefined();
  });

  test('rejects an empty DNS answer rather than treating it as safe', async () => {
    await expect(assertHostResolvesToPublicAddress('empty-answer.example.com', async () => [])).rejects.toThrow(
      /no addresses/i,
    );
  });

  test('rejects a malformed address rather than treating it as safe', async () => {
    await expect(
      assertHostResolvesToPublicAddress('bad-answer.example.com', lookupTo('not-an-ip')),
    ).rejects.toThrow(/invalid address/i);
  });

  test('surfaces a resolver failure instead of allowing the crawl', async () => {
    const lookup = async () => {
      throw new Error('SERVFAIL');
    };
    await expect(assertHostResolvesToPublicAddress('resolver-down.example.com', lookup)).rejects.toThrow(/DNS lookup failed/i);
  });

  // The module caches SAFE hosts to avoid re-resolving. A failure must not
  // be cached, or one transient SERVFAIL would poison the host until restart.
  test('does not cache failures — a later successful lookup is honoured', async () => {
    let attempt = 0;
    const flaky = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient SERVFAIL');
      return [{ address: '93.184.216.34', family: 4 }];
    };
    await expect(assertHostResolvesToPublicAddress('flaky-host.example.com', flaky)).rejects.toThrow(/DNS lookup failed/i);
    await expect(assertHostResolvesToPublicAddress('flaky-host.example.com', flaky)).resolves.toBeUndefined();
    expect(attempt).toBe(2);
  });

  test.each(['localhost', '127.0.0.1', '0.0.0.0', '::1'])('blocks the literal blocked host %s before any DNS call', async (host) => {
    let called = false;
    const lookup = async () => {
      called = true;
      return [{ address: '93.184.216.34', family: 4 }];
    };
    await expect(assertHostResolvesToPublicAddress(host, lookup)).rejects.toThrow();
    expect(called).toBe(false);
  });

  test.each(['printer.local', 'db.internal', 'app.localhost', 'box.localdomain'])(
    'blocks the internal-network suffix host %s',
    async (host) => {
      await expect(assertHostResolvesToPublicAddress(host, lookupTo('93.184.216.34'))).rejects.toThrow();
    },
  );
});

describe('assertTargetEligible', () => {
  test('rejects an inactive source', () => {
    expect(() => assertTargetEligible(makeSource({ active: false }))).toThrow(/inactive/i);
  });

  test('rejects a disallow robots policy', () => {
    expect(() => assertTargetEligible(makeSource({ robotsPolicy: 'disallow' }))).toThrow(/robots/i);
  });

  // Fail-closed: a target whose robots posture was never determined must not
  // be crawled just because nothing explicitly forbade it.
  test('rejects an unknown robots policy (fails closed)', () => {
    expect(() => assertTargetEligible(makeSource({ robotsPolicy: 'unknown' }))).toThrow(/unknown robots/i);
  });

  test('rejects a non-https base URL', () => {
    expect(() => assertTargetEligible(makeSource({ baseUrl: 'http://venue.example.com' }))).toThrow(/https/i);
  });

  test('rejects credentials embedded in the base URL', () => {
    expect(() =>
      assertTargetEligible(makeSource({ baseUrl: 'https://user:pass@venue.example.com' })),
    ).toThrow(/[Cc]redentialed/);
  });

  test('rejects a base URL pointing at an internal host', () => {
    expect(() => assertTargetEligible(makeSource({ baseUrl: 'https://localhost' }))).toThrow();
  });

  test('accepts a well-formed public https source', () => {
    expect(() => assertTargetEligible(makeSource())).not.toThrow();
  });
});

describe('assertRequestUrlAllowed — same-site enforcement', () => {
  const source = makeSource();

  test('allows a same-host path', () => {
    expect(assertRequestUrlAllowed(source, 'https://venue.example.com/events/list').pathname).toBe('/events/list');
  });

  // OFFDOMAIN-WWW-1: a source registered at the apex must be able to crawl
  // its own www pages (and vice versa) — the most common in-page link shape.
  test('allows the apex/www counterpart of the registered host', () => {
    expect(() => assertRequestUrlAllowed(source, 'https://www.venue.example.com/events')).not.toThrow();
    const wwwSource = makeSource({ baseUrl: 'https://www.venue.example.com' });
    expect(() => assertRequestUrlAllowed(wwwSource, 'https://venue.example.com/events')).not.toThrow();
  });

  test('blocks a genuinely different host', () => {
    expect(() => assertRequestUrlAllowed(source, 'https://evil.example.net/events')).toThrow(/off-domain/i);
  });

  // A subdomain is NOT the same site — this is the shape an attacker gets
  // from a page that links its own CDN/user-content host.
  test('blocks an unrelated subdomain of the same registrable domain', () => {
    expect(() => assertRequestUrlAllowed(source, 'https://uploads.venue.example.com/x')).toThrow(/off-domain/i);
  });

  test('blocks a host that merely has the base host as a suffix', () => {
    expect(() => assertRequestUrlAllowed(source, 'https://notvenue.example.com/events')).toThrow(/off-domain/i);
  });

  test('blocks non-https', () => {
    expect(() => assertRequestUrlAllowed(source, 'http://venue.example.com/events')).toThrow(/non-https/i);
  });

  test('blocks credentialed URLs', () => {
    expect(() => assertRequestUrlAllowed(source, 'https://u:p@venue.example.com/e')).toThrow(/[Cc]redentialed/);
  });

  test('blocks a cross-port URL on the same host', () => {
    expect(() => assertRequestUrlAllowed(source, 'https://venue.example.com:8443/events')).toThrow(/cross-port/i);
  });

  test('blocks an unparseable URL', () => {
    expect(() => assertRequestUrlAllowed(source, 'not a url')).toThrow(/Invalid crawl URL/i);
  });
});

describe('assertRedirectUrlAllowed / ForHost — redirect following', () => {
  const source = makeSource();

  test('follows the apex/www redirect', () => {
    expect(() => assertRedirectUrlAllowed(source, 'https://www.venue.example.com/events/')).not.toThrow();
  });

  test('refuses to follow a redirect to another host', () => {
    expect(() => assertRedirectUrlAllowed(source, 'https://tracker.example.net/r?u=1')).toThrow(/off-domain/i);
  });

  test('refuses an https-to-http downgrade redirect', () => {
    expect(() => assertRedirectUrlAllowed(source, 'http://venue.example.com/events')).toThrow(/non-https/i);
  });

  test('refuses a redirect to an internal host', () => {
    expect(() => assertRedirectUrlAllowed(source, 'https://localhost/admin')).toThrow();
  });

  // The URL-only variant used where no source record exists.
  test('ForHost enforces the same rules without a source record', () => {
    expect(() => assertRedirectUrlAllowedForHost('venue.example.com', '', 'https://www.venue.example.com/x')).not.toThrow();
    expect(() => assertRedirectUrlAllowedForHost('venue.example.com', '', 'https://evil.example.net/x')).toThrow(/off-domain/i);
    expect(() => assertRedirectUrlAllowedForHost('venue.example.com', '', 'https://venue.example.com:9000/x')).toThrow(/cross-port/i);
    expect(() => assertRedirectUrlAllowedForHost('venue.example.com', '', 'https://169.254.169.254/latest/meta-data/')).toThrow();
  });
});
