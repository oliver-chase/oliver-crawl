import { describe, expect, test, vi } from 'vitest';
import { assertHostResolvesToPublicAddress, __dnsCacheSizeForTests } from '@/fetch/host-policy';

// DNS-CACHE-BOUND-1: the verdict cache stays bounded, and a cached verdict never outlives its lifetime.

describe('DNS verdict cache', () => {
  test('stays bounded across a very wide crawl', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    for (let i = 0; i < 10_050; i++) await assertHostResolvesToPublicAddress(`host-${i}.example.com`, lookup);
    expect(__dnsCacheSizeForTests(lookup)).toBeLessThanOrEqual(10_000);
  });

  test('a host that later resolves to a private address is refused once its verdict expires', async () => {
    vi.useFakeTimers();
    let address = '93.184.216.34';
    const lookup = async () => [{ address, family: 4 }];
    await assertHostResolvesToPublicAddress('rebind.example.com', lookup);
    address = '10.0.0.5';
    await expect(assertHostResolvesToPublicAddress('rebind.example.com', lookup)).resolves.toBeUndefined();
    vi.advanceTimersByTime(61_000);
    await expect(assertHostResolvesToPublicAddress('rebind.example.com', lookup)).rejects.toThrow(/private IPv4/i);
  });

  test('a repeat lookup inside the lifetime reuses the verdict', async () => {
    let lookups = 0;
    const lookup = async () => {
      lookups++;
      return [{ address: '93.184.216.34', family: 4 }];
    };
    for (let i = 0; i < 5; i++) await assertHostResolvesToPublicAddress('reuse.example.com', lookup);
    expect(lookups).toBe(1);
  });
});
