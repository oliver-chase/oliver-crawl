import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { closeSharedPool, pooledFetch } from '@/fetch/connection-pool';
import { fetchFollowingSafeRedirects } from '@/fetch/http-mechanics';
import { resolveConfig } from '@/core/config';

// POOL-REUSE-1: direct fetches share one keep-alive pool, so repeat requests to a host reuse a connection.

let server: Server;
let base: string;
let connections = 0;
let requests: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/target' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  server.on('connection', () => (connections += 1));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await closeSharedPool();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
});

describe('shared connection pool', () => {
  beforeEach(closeSharedPool);

  test('repeat requests to one host reuse open connections', async () => {
    connections = 0;
    for (let i = 0; i < 8; i++) {
      const res = await pooledFetch(`${base}/page-${i}`);
      expect(await res.text()).toBe('ok');
    }
    // Eight sequential requests open at most two sockets: the runtime opens one spare while the first request is in flight.
    expect(connections).toBeLessThanOrEqual(2);
  });

  test('the direct fetch uses the pool by default', async () => {
    connections = 0;
    const config = resolveConfig({ userAgent: 'TestBot/1.0 (+https://example.com/bot)' });
    for (let i = 0; i < 8; i++) {
      const res = await fetchFollowingSafeRedirects(new URL(`${base}/direct-${i}`), config, 5_000);
      await res.text();
    }
    // Eight sequential requests open at most two sockets: the runtime opens one spare while the first request is in flight.
    expect(connections).toBeLessThanOrEqual(2);
  });

  test('a redirect to a private address is refused with no request sent to it, even on a warm connection', async () => {
    const config = resolveConfig({ userAgent: 'TestBot/1.0 (+https://example.com/bot)' });
    await (await fetchFollowingSafeRedirects(new URL(`${base}/warm`), config, 5_000)).text();
    requests = [];
    await expect(fetchFollowingSafeRedirects(new URL(`${base}/redirect`), config, 5_000)).rejects.toThrow();
    expect(requests).toEqual(['/redirect']);
  });
});
