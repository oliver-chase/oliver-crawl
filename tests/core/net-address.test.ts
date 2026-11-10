import { describe, expect, test } from 'vitest';
import { isBlockedHostname, isPrivateIpv4, isPrivateIpv6 } from '../../src/core/net-address.js';

describe('isPrivateIpv4 range edges', () => {
  test.each([
    '0.0.0.1', '10.255.255.255', '100.64.0.0', '100.127.255.255', '127.0.0.1', '169.254.169.254',
    '172.16.0.0', '172.31.255.255', '192.168.0.1', '198.18.0.0', '198.19.255.255', '224.0.0.1',
  ])('%s is private', (address) => {
    expect(isPrivateIpv4(address)).toBe(true);
  });

  test.each(['100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '198.17.255.255', '198.20.0.0', '8.8.8.8'])(
    '%s is public',
    (address) => {
      expect(isPrivateIpv4(address)).toBe(false);
    },
  );
});

describe('isPrivateIpv6', () => {
  test.each([
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1', '2001:db8::1',
    '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:a00:1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::1', '::7f00:1', '2002:7f00:1::', '2002:a9fe:a9fe::1', '2001:0:1::1',
  ])('%s is private', (address) => {
    expect(isPrivateIpv6(address)).toBe(true);
  });

  test.each(['2606:4700::1111', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1'])('%s is public', (address) => {
    expect(isPrivateIpv6(address)).toBe(false);
  });
});

describe('isBlockedHostname', () => {
  test.each([
    'localhost', 'localhost.', 'metadata.internal', 'printer.local', '2130706433', '[::1]',
    '[::ffff:7f00:1]', '[::ffff:a9fe:a9fe]', '[64:ff9b::7f00:1]', '::ffff:10.0.0.1',
  ])('%s is blocked', (host) => {
    expect(isBlockedHostname(host)).toBe(true);
  });

  test.each(['example.com', 'sub.example.org', '[2606:4700::1111]', '8.8.8.8'])('%s is allowed', (host) => {
    expect(isBlockedHostname(host)).toBe(false);
  });

  test('the URL parser writes a mapped loopback in hex and it is still blocked', () => {
    expect(isBlockedHostname(new URL('http://[::ffff:127.0.0.1]/').hostname)).toBe(true);
  });
});
