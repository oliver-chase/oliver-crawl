import { describe, expect, test } from 'vitest';
import { extractJsonLdAddress, formatJsonLdAddress } from '@/extract/jsonld-address';

describe('extractJsonLdAddress', () => {
  test('finds a top-level PostalAddress node', () => {
    const script = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Place',
      name: 'Example Park',
      address: {
        '@type': 'PostalAddress',
        streetAddress: '123 Example Street',
        addressLocality: 'Exampletown',
        addressRegion: 'EX',
        postalCode: '12345',
      },
    });
    expect(extractJsonLdAddress([script])).toEqual({
      streetAddress: '123 Example Street',
      city: 'Exampletown',
      state: 'EX',
      postalCode: '12345',
    });
  });

  test('finds an address nested under Event.location', () => {
    const script = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Event',
      name: 'Summer Concert',
      location: {
        '@type': 'Place',
        name: 'Example Gazebo',
        address: {
          '@type': 'PostalAddress',
          streetAddress: '456 Sample Avenue',
          addressLocality: 'Sampleville',
          addressRegion: 'NY',
        },
      },
    });
    expect(extractJsonLdAddress([script])).toMatchObject({
      streetAddress: '456 Sample Avenue',
      city: 'Sampleville',
      state: 'NY',
    });
  });

  test('finds an address inside an @graph array', () => {
    const script = JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', name: 'Town Site' },
        { '@type': 'Place', address: { streetAddress: '100 Main St', addressLocality: 'Testburg', addressRegion: 'NY' } },
      ],
    });
    expect(extractJsonLdAddress([script])).toMatchObject({ streetAddress: '100 Main St', city: 'Testburg' });
  });

  test('handles a top-level array of JSON-LD nodes', () => {
    const script = JSON.stringify([
      { '@type': 'Organization', name: 'Acme' },
      { '@type': 'Place', address: { streetAddress: '5 Elm St' } },
    ]);
    expect(extractJsonLdAddress([script])?.streetAddress).toBe('5 Elm St');
  });

  test('skips a malformed script and keeps checking the rest', () => {
    const scripts = ['{not valid json', JSON.stringify({ address: { streetAddress: '9 Oak St' } })];
    expect(extractJsonLdAddress(scripts)?.streetAddress).toBe('9 Oak St');
  });

  test('returns null when no script has an address', () => {
    const script = JSON.stringify({ '@type': 'Organization', name: 'Acme', url: 'https://acme.example' });
    expect(extractJsonLdAddress([script])).toBeNull();
  });

  test('returns null for an empty script list', () => {
    expect(extractJsonLdAddress([])).toBeNull();
  });

  test('ignores a blank/whitespace-only streetAddress', () => {
    const script = JSON.stringify({ address: { streetAddress: '   ' } });
    expect(extractJsonLdAddress([script])).toBeNull();
  });
});

describe('formatJsonLdAddress', () => {
  test('joins the parts that are present, skipping missing ones', () => {
    expect(
      formatJsonLdAddress({ streetAddress: '456 Sample Avenue', city: 'Sampleville', state: 'NY', postalCode: '12345-6789' }),
    ).toBe('456 Sample Avenue, Sampleville, NY, 12345-6789');
    expect(formatJsonLdAddress({ streetAddress: '5 Elm St', city: null, state: null, postalCode: null })).toBe('5 Elm St');
  });
});
