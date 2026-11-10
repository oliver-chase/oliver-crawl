import { describe, expect, test } from 'vitest';
import { assertLandedSameSite } from '@/fetch/local-render';
import { publicDns } from '../helpers';

// RENDER-REDIRECT-1: page.goto follows the whole redirect chain inside
// Chromium, and the caller then builds the page with the URL it ASKED for. An
// origin could bounce this rung anywhere — including a private address — and
// have that content returned under the original URL.

const privateDns = async () => [{ address: '127.0.0.1', family: 4 }];

describe('the browser must land where it was sent', () => {
  test('same host passes', async () => {
    await expect(
      assertLandedSameSite('https://site.example.com/final', 'https://site.example.com/start', publicDns),
    ).resolves.toBeUndefined();
  });

  test('www and apex are the same site', async () => {
    await expect(
      assertLandedSameSite('https://www.site.example.com/x', 'https://site.example.com/x', publicDns),
    ).resolves.toBeUndefined();
  });

  test('an off-site landing is refused', async () => {
    await expect(
      assertLandedSameSite('https://attacker.example.net/collect', 'https://site.example.com/x', publicDns),
    ).rejects.toThrow(/off-domain/i);
  });

  test('a subdomain is not the same site', async () => {
    // Subdomains are frequently a different publisher; only www is folded.
    await expect(
      assertLandedSameSite('https://internal.site.example.com/x', 'https://site.example.com/x', publicDns),
    ).rejects.toThrow(/off-domain/i);
  });
});

describe('a same-named host can still resolve somewhere private', () => {
  test('a private-resolving landing is refused even on the same host', async () => {
    // DNS rebinding between the policy check and the browser's own lookup.
    await expect(
      assertLandedSameSite('https://site.example.com/x', 'https://site.example.com/x', privateDns),
    ).rejects.toThrow();
  });
});

describe('non-http destinations are refused', () => {
  test('a file: landing is refused', async () => {
    await expect(
      assertLandedSameSite('file:///etc/passwd', 'https://site.example.com/x', publicDns),
    ).rejects.toThrow();
  });
});

// A hostname-only comparison would allow cross-port, credentialed and
// scheme-changing landings. The canonical redirect guard refuses all three, and
// the landing check delegates to it.
describe('the landing check matches every other rung', () => {
  test('cross-port is refused', async () => {
    await expect(
      assertLandedSameSite('https://site.example.com:8443/x', 'https://site.example.com/x', publicDns),
    ).rejects.toThrow(/cross-port/i);
  });

  test('an https to http downgrade is refused', async () => {
    await expect(
      assertLandedSameSite('http://site.example.com/x', 'https://site.example.com/x', publicDns),
    ).rejects.toThrow();
  });

  test('a credentialed landing URL is refused', async () => {
    await expect(
      assertLandedSameSite('https://admin:pw@site.example.com/x', 'https://site.example.com/x', publicDns),
    ).rejects.toThrow(/credential/i);
  });
});
