import { describe, expect, test } from 'vitest';
import { configFromEnv } from '@/core/config';
import { urlDedupKey } from '@/core/url-dedup-key';
import { sanitizeCrawledText } from '@/guard/prompt-injection-guard';

// A template key does not enable a paid rung, two different pages keep two keys, and a redaction leaves working URLs alone.

describe('placeholder API keys', () => {
  test.each(['your-key-here', 'xxxxxxxxxxxx', 'YOUR_API_KEY', '<paste-key>', 'changeme-please', '............', 'TODO later on'])('%s is absent', (value) => {
    const config = configFromEnv({ FIRECRAWL_API_KEY: value, APIFY_API_TOKEN: value });
    expect(config.vendor?.firecrawl).toBeUndefined();
    expect(config.vendor?.apify).toBeUndefined();
  });

  test('a real-looking key is kept', () => {
    expect(configFromEnv({ FIRECRAWL_API_KEY: 'fc-3f9a7c21b8d04e6a' }).vendor?.firecrawl).toBe('fc-3f9a7c21b8d04e6a');
  });
});

describe('query identity', () => {
  test('an encoded ampersand and a real one are different pages', () => {
    expect(urlDedupKey('https://shop.example/search?a=1%26b%3D3')).not.toBe(urlDedupKey('https://shop.example/search?a=1&b=3'));
  });

  test('parameter order and tracking parameters still collapse', () => {
    expect(urlDedupKey('https://shop.example/s?b=2&a=1&utm_source=x')).toBe(urlDedupKey('https://shop.example/s?a=1&b=2'));
  });
});

describe('redaction of an encoded blob', () => {
  const run = 'Ab1' + 'cD2eF3gH4iJ5kL6mN7oP8qR9sT0uVwXyZ'.repeat(3);

  test('masks the blob in prose and leaves the same run inside a URL', () => {
    const out = sanitizeCrawledText(`Download token ${run} follows. Asset: https://static.example.com/x/${run}.png end.`, 100_000).text;
    expect(out).toContain(`https://static.example.com/x/${run}.png`);
    expect(out).not.toContain(`token ${run}`);
    expect(out).toContain('[REDACTED_PROMPT_INJECTION]');
  });
});
