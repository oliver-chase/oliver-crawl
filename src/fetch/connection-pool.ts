// ─── Connection pool for the direct-fetch rung ──────────────────────────────
//
// A keep-alive pool per resolver, so a second request to a host reuses the open connection and
// skips the TCP and TLS handshake. The address check runs before every request regardless, and a
// new connection goes only to an address that check approved.

import { lookup as systemLookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import { approvedAddressesFor, assertPublicResolvedAddress, defaultDnsLookup } from './host-policy.js';
import type { DnsAddress, DnsLookupFn } from '../core/types.js';

/** Idle connections close before the 60-second DNS verdict lifetime, so a pooled socket never outlives the answer that approved it. */
const POOL_IDLE_MS = 30_000;
/** Open connections per origin. The per-host request limit in the crawl is lower, so this never queues a crawl. */
const POOL_CONNECTIONS_PER_ORIGIN = 8;

/**
 * POOL-PIN-1: where a new connection goes. A host the resolver approved connects to the addresses it
 * was approved at. A host with no live approval is resolved by the system and every answer must be
 * public, so a fetch path that skipped the check still cannot reach a private address.
 */
export function pinnedLookup(
  lookupFn: DnsLookupFn,
  resolve: (host: string) => Promise<DnsAddress[]> = (host) => systemLookup(host, { all: true }),
) {
  return (
    hostname: string,
    options: { all?: boolean },
    callback: (error: Error | null, address: never, family?: number) => void,
  ): void => {
    const done = callback as unknown as (error: Error | null, address?: string | DnsAddress[], family?: number) => void;
    void (async () => {
      const addresses = approvedAddressesFor(hostname, lookupFn) ?? (await resolve(hostname));
      if (!addresses.length) throw new Error(`No address for ${hostname}`);
      for (const a of addresses) assertPublicResolvedAddress(a.address, hostname);
      return addresses;
    })().then(
      (addresses) => (options.all ? done(null, addresses) : done(null, addresses[0]!.address, addresses[0]!.family)),
      (error: Error) => done(error),
    );
  };
}

const AGENTS = new Map<DnsLookupFn, Agent>();
const MAX_POOLS = 16;
// The fetch the runtime started with. A test or host that replaces globalThis.fetch is called as given.
const RUNTIME_FETCH = globalThis.fetch;

/** POOL-REUSE-1: one Agent per resolver, created on first use. */
function agentFor(lookupFn: DnsLookupFn): Agent {
  let agent = AGENTS.get(lookupFn);
  if (!agent) {
    // One pool per resolver, capped, so a caller that builds a resolver closure per crawl cannot grow the process without bound.
    if (AGENTS.size >= MAX_POOLS) {
      const [oldestKey, oldest] = AGENTS.entries().next().value as [DnsLookupFn, Agent];
      AGENTS.delete(oldestKey);
      void oldest.close().catch(() => {});
    }
    agent = new Agent({
      keepAliveTimeout: POOL_IDLE_MS,
      keepAliveMaxTimeout: POOL_IDLE_MS,
      connections: POOL_CONNECTIONS_PER_ORIGIN,
      connect: { lookup: pinnedLookup(lookupFn) },
    });
    AGENTS.set(lookupFn, agent);
  }
  return agent;
}

/**
 * A fetch that sends each request through the pool for `dnsLookup` (the default resolver when absent).
 * POOL-NODE-1: the runtime's own fetch runs on the undici the runtime bundles, and handing it an Agent
 * from another undici version fails on some Node releases, so the pool uses undici's own fetch.
 */
export function pooledFetchFor(dnsLookup?: DnsLookupFn): typeof fetch {
  const lookupFn = dnsLookup ?? defaultDnsLookup;
  return (input, init) => {
    const dispatcher = agentFor(lookupFn);
    if (globalThis.fetch === RUNTIME_FETCH) {
      return undiciFetch(input as Parameters<typeof undiciFetch>[0], { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
    }
    return globalThis.fetch(input, { ...init, dispatcher } as RequestInit);
  };
}

/** Closes every pool. Tests and long-lived hosts call this to release sockets. */
export async function closeSharedPool(): Promise<void> {
  const open = [...AGENTS.values()];
  AGENTS.clear();
  await Promise.all(open.map((agent) => agent.close()));
}
