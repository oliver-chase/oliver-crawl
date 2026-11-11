// ─── Shared connection pool for the direct-fetch rung ───────────────────────
//
// One keep-alive pool per process, so a second request to a host reuses the open connection and
// skips the TCP and TLS handshake. The address check runs before every request regardless, because
// a pooled connection only ever carries a request that already passed it.

import { Agent } from 'undici';

/** Idle connections close before the 60-second DNS verdict lifetime, so a pooled socket never outlives the answer that approved it. */
export const POOL_IDLE_MS = 30_000;
/** Open connections per origin. The per-host request limit in the crawl is lower, so this never queues a crawl. */
export const POOL_CONNECTIONS_PER_ORIGIN = 8;

let shared: Agent | undefined;

/**
 * POOL-REUSE-1: the dispatcher every direct fetch shares. Created on first use.
 */
export function sharedDispatcher(): Agent {
  shared ??= new Agent({ keepAliveTimeout: POOL_IDLE_MS, keepAliveMaxTimeout: POOL_IDLE_MS, connections: POOL_CONNECTIONS_PER_ORIGIN });
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
