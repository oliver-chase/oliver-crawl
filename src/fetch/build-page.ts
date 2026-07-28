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
/**
 * QUARANTINE-EVIDENCE-1: a refusal that carries what tripped it.
 *
 * This was a bare `'quarantined'` string, which told the caller the page was
 * withheld and nothing else. A consumer that must never lose a page had no
 * material to build a review task from, so the only thing it could do was drop
 * it — silently, which is what quarantining exists to prevent.
 */
export type QuarantineEvidence = {
  quarantined: true;
  signals: PromptInjectionSignal[];
  text: string;
  title: string | null;
};

export function isQuarantined(value: unknown): value is QuarantineEvidence {
  return typeof value === 'object' && value !== null && (value as QuarantineEvidence).quarantined === true;
}

import type { PromptInjectionSignal } from '../guard/prompt-injection-guard.js';
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
}): Promise<CrawlPage | QuarantineEvidence> {
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

  // GUARD-TITLE-1: <title> lives in <head>, so it was never part of the body
  // text or the markdown the guard inspects, and shipped raw. A title is page
  // content — callers display it and feed it to models — so it gets the same
  // treatment as everything else the page supplies.
  const rawTitle = $('title').first().text().trim();
  const titleGuard = rawTitle ? sanitizeCrawledText(rawTitle, input.maxTextChars) : null;
  if (titleGuard && titleGuard.signals.length > 0) {
    return { quarantined: true, signals: titleGuard.signals, text: titleGuard.text, title: null };
  }
  const title = rawTitle || null;

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
  if (sanitized.signals.length > 0) {
    return { quarantined: true, signals: sanitized.signals, text: sanitized.text, title };
  }

  // Markdown is untrusted page content exactly like the text is — an
  // injection payload inside a <table> cell is still an injection payload,
  // and this is the field callers are told to feed a model.
  const sanitizedMarkdown = sanitizeCrawledText(markdownRaw, input.maxTextChars);
  if (sanitizedMarkdown.signals.length > 0) {
    return { quarantined: true, signals: sanitizedMarkdown.signals, text: sanitizedMarkdown.text, title };
  }

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
    redactionCount: sanitized.redactionCount,
    truncated: sanitized.truncated,
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
// PAGE-SHAPE-1: both constructors here are held to one contract by
// tests/lanes/page-shape.test.ts, which drives every rung end to end and
// checks what is IN the page rather than that a page came back. A dropped
// field surfaces as worse extraction blamed on the sites, not as an error.
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
  /**
   * GUARD-TELEMETRY-1: what the guard did, from the caller that ran it.
   *
   * These were hardcoded to 0/false here on the reasoning that a text rung
   * "receives prose that has already been through the guard, so nothing was
   * redacted or capped at THIS step". That was wrong, and QA proved it on all
   * four text rungs: each one calls sanitizeCrawledText immediately before
   * this and throws the result away. Pages came back reporting complete and
   * unmodified while the delivered text literally contained [TRUNCATED].
   *
   * Passed in rather than recomputed, because only the caller holds the
   * sanitiser result and re-running the guard here would be a second pass over
   * the same text to learn something already known.
   */
  redactionCount?: number;
  truncated?: boolean;
  /**
   * Set ONLY when the rung's text already IS markdown.
   *
   * The vendor rungs are asked for markdown explicitly (Firecrawl with
   * `onlyMainContent`), so their text is markdown and belongs in both fields —
   * the same value, not a second conversion. Jina returns prose that merely
   * looks markdown-ish, so it leaves this unset and reports an empty
   * `markdown` rather than claiming structure it did not derive.
   *
   * Defaults to empty, which is the honest answer for a rung with no HTML.
   */
  markdown?: string;
}): Promise<CrawlPage> {
  const textSha256 = await sha256Hex(input.text);
  return {
    url: input.url,
    text: input.text,
    markdown: input.markdown ?? '',
    contentKind: input.contentKind,
    likelyEmptyState: looksLikeEmptyState(input.text),
    candidateContentImages: [],
    extractorVersion: EXTRACTOR_VERSION,
    // Defaults only for a caller that genuinely ran no guard; every rung that
    // sanitises passes its own numbers. See the field docs above for why the
    // previous hardcoded 0/false was a lie rather than a simplification.
    redactionCount: input.redactionCount ?? 0,
    truncated: input.truncated ?? false,
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
