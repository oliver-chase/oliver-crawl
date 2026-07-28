// ─── HTML to CrawlPage ──────────────────────────────────────────────────────
//
// The single place raw HTML becomes the shape a consumer receives: text,
// markdown, structured data, links, hashes and the guard verdict.
//
// Extracted from the own lane so that file holds policy and the rung ladder
// only. Every rung that produces HTML routes through here, which is what
// keeps one parser, one guard and one page shape across the direct fetch, the
// render rungs and the archive rung — a second construction path is how those
// drift apart.

import * as cheerio from 'cheerio';
import { htmlToMarkdown } from '../extract/html-to-markdown.js';
import { summarizeStructuredData } from '../extract/structured-summary.js';
import { findContentImages } from '../extract/content-images.js';
import { computeContentRegionHash } from '../extract/content-region-hash.js';
import { extractInlineScriptContent, shouldRecoverFromScripts } from '../extract/spa-content-extract.js';
import { sanitizeCrawledText } from '../guard/prompt-injection-guard.js';
import { looksLikeEmptyState } from '../core/soft-404.js';
import { EXTRACTOR_VERSION } from '../core/extractor-version.js';
import { sha256Hex } from '../core/hash.js';
import type { CrawlPage, PageLink } from '../core/types.js';

export async function buildPage(input: {
  url: string;
  html: string;
  contentType: string;
  etag: string | null;
  lastModified: string | null;
  baseHost: string;
  maxTextChars: number;
  rung: string;
  includeHtml: boolean;
  maxLinks: number;
  maxOutboundHosts: number;
}): Promise<CrawlPage | 'quarantined'> {
  // ONE parse (CRAWL-PERF-1, found in self-audit): the first version loaded
  // the document once for text, then RELOADED it once per JSON-LD script tag
  // inside the .each — N+1 full parses on a page with N structured-data
  // blocks. JSON-LD is read from this same tree BEFORE the script tags are
  // stripped for text extraction.
  const $ = cheerio.load(input.html);

  const jsonLd: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    try {
      jsonLd.push(JSON.parse(raw));
    } catch {
      // Malformed JSON-LD is common in the wild — skip this block, keep the rest.
    }
  });

  const title = $('title').first().text().trim() || null;

  // Built BEFORE the destructive strip below, and from a clone internally, so
  // the link pass further down still sees the whole document.
  const markdownRaw = htmlToMarkdown($, { maxChars: input.maxTextChars });

  $('script, style, noscript, template').remove();
  let visibleText = $('body').text().replace(/\s+/g, ' ').trim();

  // A JS shell serves no readable body but often ships its content as an
  // inline JSON payload — recover it rather than reporting the page empty.
  if (shouldRecoverFromScripts(visibleText)) {
    const recovered = extractInlineScriptContent(input.html);
    if (recovered && recovered.length > visibleText.length) visibleText = recovered;
  }

  // Guard BEFORE returning: nothing downstream should ever see raw page text.
  const sanitized = sanitizeCrawledText(visibleText, input.maxTextChars);
  if (sanitized.signals.length > 0) return 'quarantined';

  // Markdown is untrusted page content exactly like the text is — an
  // injection payload inside a <table> cell is still an injection payload,
  // and this is the field callers are told to feed a model.
  const sanitizedMarkdown = sanitizeCrawledText(markdownRaw, input.maxTextChars);
  if (sanitizedMarkdown.signals.length > 0) return 'quarantined';

  const links: PageLink[] = [];
  const outbound = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let resolved: URL;
    try {
      resolved = new URL(href, input.url);
    } catch {
      return;
    }
    if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return;

    const sameSite = resolved.hostname.replace(/^www\./, '') === input.baseHost.replace(/^www\./, '');
    if (sameSite) {
      if (links.length < input.maxLinks) links.push({ url: resolved.toString(), text: $(el).text().trim().slice(0, 200) });
    } else if (outbound.size < input.maxOutboundHosts) {
      outbound.add(resolved.hostname);
    }
  });

  return {
    url: input.url,
    text: sanitized.text,
    markdown: sanitizedMarkdown.text,
    contentKind: 'html',
    // Judged on the MAIN content, not the whole page: a site whose nav and
    // footer are large would otherwise never look empty, which is exactly
    // the page this is meant to catch.
    likelyEmptyState: looksLikeEmptyState(sanitizedMarkdown.text || sanitized.text),
    candidateContentImages: findContentImages($, input.url),
    extractorVersion: EXTRACTOR_VERSION,
    structuredData: summarizeStructuredData(jsonLd),
    title,
    ...(input.includeHtml ? { html: input.html } : {}),
    contentType: input.contentType,
    bodySha256: await sha256Hex(input.html),
    contentRegionSha256: await computeContentRegionHash(input.html),
    textSha256: await sha256Hex(sanitized.text),
    httpEtag: input.etag,
    httpLastModified: input.lastModified,
    jsonLd,
    outboundHosts: [...outbound],
    links,
    lane: 'own',
    rung: input.rung,
  };
}

/**
 * Build a CrawlPage for a rung that produced TEXT rather than HTML — the
 * calendar/CSV/JSON documents, the PDF text layer, Jina, and the vendor lane.
 *
 * These four rungs each hand-assembled the same object literal. Adding a
 * REQUIRED field to CrawlPage surfaced every one of them through the type
 * checker, but an optional field would not have, and the rungs would have
 * drifted apart silently — one returning a field the others omit is exactly
 * the kind of difference a consumer discovers as inconsistent data rather
 * than as an error.
 *
 * The HTML-derived fields are empty here rather than faked, which is the same
 * honesty rule `contentRegionSha256` follows: a rung change must never look
 * like a content change.
 */
export async function buildTextPage(input: {
  url: string;
  text: string;
  contentKind: CrawlPage['contentKind'];
  contentType: string;
  rung: string;
  lane: CrawlPage['lane'];
  title?: string | null;
  etag?: string | null;
  lastModified?: string | null;
  /** Hash source when the delivered text is not what arrived on the wire. */
  bodySource?: string;
}): Promise<CrawlPage> {
  const textSha256 = await sha256Hex(input.text);
  return {
    url: input.url,
    text: input.text,
    markdown: '',
    contentKind: input.contentKind,
    likelyEmptyState: looksLikeEmptyState(input.text),
    candidateContentImages: [],
    extractorVersion: EXTRACTOR_VERSION,
    structuredData: summarizeStructuredData([]),
    title: input.title ?? null,
    contentType: input.contentType,
    bodySha256: input.bodySource === undefined ? textSha256 : await sha256Hex(input.bodySource),
    contentRegionSha256: '',
    textSha256,
    httpEtag: input.etag ?? null,
    httpLastModified: input.lastModified ?? null,
    jsonLd: [],
    outboundHosts: [],
    links: [],
    lane: input.lane,
    rung: input.rung,
  };
}
