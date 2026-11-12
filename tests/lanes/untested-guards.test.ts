import { describe, expect, test } from 'vitest';
import { createCrawler } from '@/index';
import { readBodyCapped } from '@/fetch/http-mechanics';
import type { CrawlTarget } from '@/core/types';
import { publicDns } from '../helpers';

// Guards that need their own assertions: removing any one of them must fail a test.

const target: CrawlTarget = { baseUrl: 'https://site.example.com', robotsPolicy: 'allow', active: true };

describe('CRAWL-HARDEN-1 — the body cap bounds BYTES, not characters', () => {
  // The test named for this asserted `text.length <= maxTextChars`, which is
  // the sanitiser's character cap. The 2 MB byte cap that stops a hostile
  // origin exhausting memory had nothing asserting it at all.
  function streamOf(totalBytes: number): Response {
    // Multi-byte on purpose: with ASCII a byte cap and a character cap are
    // indistinguishable. 'é' is 2 bytes and 1 character, so a character cap
    // would read twice the bytes it may.
    const chunk = new TextEncoder().encode('é'.repeat(32 * 1024));
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (sent >= totalBytes) return controller.close();
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  }

  test('a body larger than the cap is truncated to the cap', async () => {
    const cap = 100_000;
    const text = await readBodyCapped(streamOf(1_000_000), cap);
    expect(text.length).toBeLessThanOrEqual(cap);
    expect(text.length).toBeGreaterThan(0);
    // THE assertion that separates a byte cap from a character cap. Every
    // character here is 2 bytes, so a cap on BYTES can yield at most cap/2
    // characters, while a cap on CHARACTERS yields exactly cap. Without this,
    // swapping the byte cap for a character cap — which buffers the whole body
    // first, restoring the memory exhaustion the decision prevents — kept the
    // test green.
    expect(text.length).toBeLessThanOrEqual(cap / 2);
  });

  test('an endless body is not read past the cap', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(97);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    await readBodyCapped(new Response(endless), 100_000);
    expect(pulled).toBeLessThanOrEqual(100_000 + 2 * chunk.byteLength);
  });

  test('a body under the cap is returned whole', async () => {
    const text = await readBodyCapped(new Response('short body', { status: 200 }), 100_000);
    expect(text).toBe('short body');
  });

  test('an announced oversize body is refused and not buffered', async () => {
    // No streaming body available: the content-length is all we have to go on.
    const res = new Response('x', { status: 200, headers: { 'content-length': '99999999' } });
    Object.defineProperty(res, 'body', { value: null });
    await expect(readBodyCapped(res, 1000)).rejects.toThrow(/too large/i);
  });
});
