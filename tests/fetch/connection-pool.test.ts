import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { closeSharedPool, pooledFetchFor } from '@/fetch/connection-pool';
import { fetchFollowingSafeRedirects } from '@/fetch/http-mechanics';
import { resolveConfig } from '@/core/config';

// POOL-REUSE-1 and POOL-PIN-1: direct fetches go through the pool, and the pool's connections go only to public addresses.

let server: Server;
let port = 0;
let requests: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/target` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await closeSharedPool();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
});

beforeEach(async () => {
  await closeSharedPool();
  requests = [];
});

const config = () => resolveConfig({ userAgent: 'TestBot/1.0 (+https://example.com/bot)' });

describe('connection pool', () => {
  test('a name that resolves to a private address is refused and the server sees nothing', async () => {
    await expect(pooledFetchFor()(`http://localhost:${port}/`)).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  test('the direct fetch is refused the same way', async () => {
    await expect(fetchFollowingSafeRedirects(new URL(`http://localhost:${port}/`), config(), 5_000)).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  test('a redirect to a private address is refused with no request sent to it, even on a warm connection', async () => {
    await (await fetchFollowingSafeRedirects(new URL(`http://127.0.0.1:${port}/warm`), config(), 5_000)).text();
    requests = [];
    await expect(fetchFollowingSafeRedirects(new URL(`http://127.0.0.1:${port}/redirect`), config(), 5_000)).rejects.toThrow();
    expect(requests).toEqual(['/redirect']);
  });
});
