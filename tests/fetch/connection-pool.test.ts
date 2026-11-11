import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Agent, fetch as undiciFetch } from 'undici';
import { closeSharedPool, pooledFetchFor } from '@/fetch/connection-pool';
import { dropBody } from '@/fetch/http-mechanics';
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

describe('dropped responses release their connection', () => {
  test('a refused response with a large unread body does not block the next request', async () => {
    const slow = createServer((req, res) => {
      if (req.url === '/big') {
        res.writeHead(403, { 'content-length': '5000000' });
        res.write('x'.repeat(100_000));
        return;
      }
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((done) => slow.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    const agent = new Agent({ connections: 1 });
    const first = await undiciFetch(`${base}/big`, { dispatcher: agent });
    dropBody(first as unknown as Response);
    const second = await Promise.race([
      undiciFetch(`${base}/next`, { dispatcher: agent }).then((r) => r.text()),
      new Promise<string>((r) => setTimeout(() => r('STUCK'), 2000)),
    ]);
    expect(second).toBe('ok');
    slow.closeAllConnections();
    await new Promise((done) => slow.close(done));
    await agent.destroy();
  });
});
