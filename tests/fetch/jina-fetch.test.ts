import { describe, expect, test } from 'vitest';
import { parseJinaResponse, fetchViaJina } from '@/fetch/jina-fetch';

describe('parseJinaResponse', () => {
  test('parses title + markdown content', () => {
    const body = 'Title: Example Amphitheater\nURL Source: https://venue.example.com/\n\nMarkdown Content:\n' + 'Example Yoga on July 2026. '.repeat(20);
    const r = parseJinaResponse(body);
    expect(r).not.toBeNull();
    expect(r!.title).toBe('Example Amphitheater');
    expect(r!.text).toContain('Example Yoga');
  });

  test('plain text (no prefixes) is kept as content', () => {
    const r = parseJinaResponse('Some venue with real concerts and event listings. '.repeat(10));
    expect(r).not.toBeNull();
    expect(r!.title).toBeNull();
  });

  test('Jina-reported upstream 404 = null', () => {
    expect(parseJinaResponse('Title: File not found (404 error)\n\nWarning: Target URL returned error 404: Not Found')).toBeNull();
  });

  test('CAPTCHA/challenge page = null', () => {
    expect(parseJinaResponse('Title: Just a moment...\n\nMarkdown Content:\nEnable JavaScript and cookies to continue')).toBeNull();
  });

  test('too little content = null', () => {
    expect(parseJinaResponse('Title: X\n\nMarkdown Content:\nhi')).toBeNull();
  });
});

describe('fetchViaJina', () => {
  test('returns content on a good Jina response', async () => {
    const fetchImpl = (async (url: string | URL) => {
      expect(url.toString()).toContain('https://r.jina.ai/');
      return new Response('Live concerts and shows and tickets for 2026 season. '.repeat(10), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchViaJina('https://venue.example.com/', { fetchImpl });
    expect(r).not.toBeNull();
    expect(r!.text).toContain('concerts');
  });

  test('non-2xx = null', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch;
    expect(await fetchViaJina('https://venue.example.com/', { fetchImpl })).toBeNull();
  });

  test('non-http URL = null', async () => {
    expect(await fetchViaJina('ftp://x')).toBeNull();
  });
});
