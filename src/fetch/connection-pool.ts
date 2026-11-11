// ─── Shared connection pool for the direct-fetch rung ───────────────────────
//
// One keep-alive pool per process, so a second request to a host reuses the open connection and
// skips the TCP and TLS handshake. The address check runs before every request regardless, because
// a pooled connection only ever carries a request that already passed it.

import { lookup as systemLookup } from 'node:dns/promises';
import { Agent } from 'undici';
import { approvedAddressesFor, assertPublicResolvedAddress } from './host-policy.js';
import type { DnsAddress } from '../core/types.js';

/** Idle connections close before the 60-second DNS verdict lifetime, so a pooled socket never outlives the answer that approved it. */
export const POOL_IDLE_MS = 30_000;
/** Open connections per origin. The per-host request limit in the crawl is lower, so this never queues a crawl. */
export const POOL_CONNECTIONS_PER_ORIGIN = 8;

/**
 * POOL-PIN-1: where a new connection goes. A host the crawler approved connects to the addresses it
 * was approved at. A host with no live approval is resolved by the system and every answer must be
 * public, so a fetch path that skipped the check still cannot reach a private address.
 */
export function pinnedLookup(resolve: (host: string) => Promise<DnsAddress[]> = (host) => systemLookup(host, { all: true })) {
  return (
    hostname: string,
    options: { all?: boolean },
    callback: (error: Error | null, address: never, family?: number) => void,
  ): void => {
    const done = callback as unknown as (error: Error | null, address?: string | DnsAddress[], family?: number) => void;
    void (async () => {
      const addresses = approvedAddressesFor(hostname) ?? (await resolve(hostname));
      if (!addresses.length) throw new Error(`No address for ${hostname}`);
      for (const a of addresses) assertPublicResolvedAddress(a.address, a.family, hostname);
      return addresses;
    })().then(
      (addresses) => (options.all ? done(null, addresses) : done(null, addresses[0]!.address, addresses[0]!.family)),
      (error: Error) => done(error),
    );
  };
}

let shared: Agent | undefined;

/**
 * POOL-REUSE-1: the dispatcher every direct fetch shares. Created on first use.
 */
export function sharedDispatcher(): Agent {
  shared ??= new Agent({ keepAliveTimeout: POOL_IDLE_MS, keepAliveMaxTimeout: POOL_IDLE_MS, connections: POOL_CONNECTIONS_PER_ORIGIN, connect: { lookup: pinnedLookup() } });
  return shared;
}

/** Closes the shared pool. Tests and long-lived hosts call this to release sockets. */
export async function closeSharedPool(): Promise<void> {
  const open = shared;
  shared = undefined;
  await open?.close();
}

/** The global fetch, sent through the shared pool. */
export const pooledFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, dispatcher: sharedDispatcher() } as RequestInit);
