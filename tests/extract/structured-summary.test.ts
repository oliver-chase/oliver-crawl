import { describe, expect, test } from 'vitest';
import { summarizeStructuredData } from '@/extract/structured-summary';

// JSONLD-SIGNAL-1: `jsonLd.length > 0` is a misleading test. Most JSON-LD in
// the wild is site furniture, and a consumer that skips the LLM on that page
// silently extracts nothing.

describe('site furniture is not mistaken for content', () => {
  test('WebSite + Organization + BreadcrumbList is NOT content', () => {
    const summary = summarizeStructuredData([
      { '@type': 'WebSite', name: 'Riverside Venue' },
      { '@type': 'Organization', name: 'Riverside Venue' },
      { '@type': 'BreadcrumbList', itemListElement: [] },
    ]);
    expect(summary.nodeCount).toBe(3);
    expect(summary.hasContentData).toBe(false);
    expect(summary.contentTypes).toEqual([]);
  });

  test('an Event among the furniture IS content', () => {
    const summary = summarizeStructuredData([
      { '@type': 'WebSite', name: 'Riverside Venue' },
      { '@type': 'Event', name: 'The Hold Steady', startDate: '2026-07-11' },
    ]);
    expect(summary.hasContentData).toBe(true);
    expect(summary.contentTypes).toEqual(['Event']);
    expect(summary.types).toEqual(['Event', 'WebSite']);
  });

  test('an empty page reports no content', () => {
    const summary = summarizeStructuredData([]);
    expect(summary).toEqual({ types: [], contentTypes: [], nodeCount: 0, hasContentData: false });
  });
});

describe('real-world JSON-LD shapes are all handled', () => {
  test('@graph wrapper — what most CMS plugins emit', () => {
    const summary = summarizeStructuredData([
      { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage' }, { '@type': 'Event', name: 'Concert' }] },
    ]);
    expect(summary.hasContentData).toBe(true);
    expect(summary.contentTypes).toEqual(['Event']);
  });

  test('a nested node counts — an Event inside a Place inside a graph', () => {
    const summary = summarizeStructuredData([
      { '@type': 'WebPage', mainEntity: { '@type': 'Event', location: { '@type': 'Place', name: 'Stage' } } },
    ]);
    expect(summary.contentTypes).toEqual(['Event', 'Place']);
  });

  test('@type as an array', () => {
    const summary = summarizeStructuredData([{ '@type': ['Event', 'MusicEvent'], name: 'Show' }]);
    expect(summary.contentTypes).toEqual(['Event', 'MusicEvent']);
  });

  test('@type as a full IRI is normalised', () => {
    const summary = summarizeStructuredData([{ '@type': 'http://schema.org/Event', name: 'Show' }]);
    expect(summary.contentTypes).toEqual(['Event']);
  });

  test('a top-level array of nodes', () => {
    const summary = summarizeStructuredData([[{ '@type': 'Event' }, { '@type': 'WebSite' }]]);
    expect(summary.hasContentData).toBe(true);
  });
});

describe('untrusted input costs bounded work', () => {
  test('deep self-nesting does not blow the stack', () => {
    // JSON-LD is attacker-influenceable page content like everything else.
    let deep: Record<string, unknown> = { '@type': 'Event' };
    for (let i = 0; i < 5000; i++) deep = { '@type': 'Thing', child: deep };
    expect(() => summarizeStructuredData([deep])).not.toThrow();
  });

  test('malformed nodes are skipped, not fatal', () => {
    const summary = summarizeStructuredData([null, 'a string', 42, { noType: true }, { '@type': 'Event' }]);
    expect(summary.hasContentData).toBe(true);
    expect(summary.contentTypes).toEqual(['Event']);
  });
});
