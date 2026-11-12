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
import { simhash } from '../extract/near-duplicate.js';
import { sha256Hex } from '../core/hash.js';
import { hostsMatchAllowingWww } from './host-policy.js';
import { EXTRACTOR_VERSION } from '../core/types.js';
import type { CrawlPage, PageLink } from '../core/types.js';

const MAX_JSON_LD_STRINGS = 500;
const MIN_JSON_LD_STRING = 12;

/**
 * The keys and string values inside parsed JSON-LD, bounded in depth and count so hostile nesting costs a
 * fixed amount. `complete` is false when a bound cut the walk short, so the caller drops what it could not scan.
 */
function jsonLdStrings(value: unknown): { strings: string[]; complete: boolean } {
  const strings: string[] = [];
  let complete = true;
  const walk = (node: unknown, depth: number) => {
    if (!complete) return;
    if (typeof node === 'string') {
      if (node.length >= MIN_JSON_LD_STRING) strings.push(node);
    } else if (node && typeof node === 'object') {
      if (depth >= 8) {
        complete = false;
        return;
      }
      for (const [key, inner] of Object.entries(node)) {
        if (!Array.isArray(node) && key.length >= MIN_JSON_LD_STRING) strings.push(key);
        walk(inner, depth + 1);
      }
    }
    if (strings.length > MAX_JSON_LD_STRINGS) complete = false;
  };
  walk(value, 0);
  return { strings, complete };
}

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
  const title = titleGuard?.text || null;

  // Built BEFORE the destructive strip below, and from a clone internally, so
  // the link pass further down still sees the whole document.
  const markdownRaw = htmlToMarkdown($, { maxChars: input.maxTextChars, baseUrl: input.url });

  $('script, style, noscript, template').remove();
  let visibleText = $('body').text().replace(/\s+/g, ' ').trim();

  // A JS shell serves no readable body but often ships its content as an
  // inline JSON payload — recover it, so the page is not reported empty.
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

  // An image's alt text is page content that reaches the caller, so it passes the guard like the text does.
  const contentImages = findContentImages($, input.url);
  for (const image of contentImages) {
    const altGuard = sanitizeCrawledText(image.alt, input.maxTextChars);
    if (altGuard.signals.length > 0) return { quarantined: true, signals: altGuard.signals, text: altGuard.text, title };
  }

  // JSON-LD reaches the caller as structured data and in the summary, so every string in it passes the guard
  // like the page text does. A page can carry its payload there while its visible text stays ordinary.
  const scanned = jsonLdStrings(jsonLd);
  // JSON-LD too large or too deep to scan in full is dropped, since an unscanned part could carry the payload.
  if (!scanned.complete) jsonLd.length = 0;
  for (const text of scanned.strings) {
    const jsonLdGuard = sanitizeCrawledText(text, input.maxTextChars);
    if (jsonLdGuard.signals.length > 0) return { quarantined: true, signals: jsonLdGuard.signals, text: jsonLdGuard.text, title };
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

    const sameSite = hostsMatchAllowingWww(resolved.hostname, input.baseHost);
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
    candidateContentImages: contentImages,
    extractorVersion: EXTRACTOR_VERSION,
    // BOTH fields, because an HTML page produces two. `markdown` is capped
    // independently and is the field the README tells consumers to feed a
    // model — reporting only the text cap left a page whose markdown ended in
    // [TRUNCATED] claiming to be complete.
    redactionCount: sanitized.redactionCount + sanitizedMarkdown.redactionCount,
    truncated: sanitized.truncated || sanitizedMarkdown.truncated,
    structuredData: summarizeStructuredData(jsonLd),
    title,
    ...(input.includeHtml ? { html: input.html } : {}),
    contentType: input.contentType,
    bodySha256: await sha256Hex(input.html),
    contentRegionSha256: await computeContentRegionHash(input.html),
    textSha256: await sha256Hex(sanitized.text),
    // Link targets count by their path alone, so a shared origin in every absolute URL does not make pages alike.
    contentSimhash: simhash((sanitizedMarkdown.text || sanitized.text).replace(/\]\(https?:\/\/[^/)\s]+/g, '](')),
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
 * Build a CrawlPage for a rung that produced TEXT and no HTML — the
 * calendar/CSV/JSON documents, the PDF text layer, Jina, and the vendor lane.
 *
 * These four rungs each hand-assembled the same object literal. Adding a
 * REQUIRED field to CrawlPage surfaced every one of them through the type
 * checker, but an optional field would not have, and the rungs would have
 * drifted apart silently — one returning a field the others omit is exactly
 * the kind of difference a consumer discovers as inconsistent data rather
 * than as an error.
 *
 * The HTML-derived fields are empty here and never faked, which is the same
 * honesty rule `contentRegionSha256` follows: a rung change must never look
 * like a content change.
 */
// PAGE-SHAPE-1: both constructors here are held to one contract by
// tests/lanes/page-shape.test.ts, which drives every rung end to end and
// checks what is IN the page, beyond the fact that a page came back. A dropped
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
   * Each text rung calls sanitizeCrawledText immediately before this, so the
   * guard may have redacted or capped the text at this step. Reporting 0/false
   * here would show a page as complete and unmodified while the delivered text
   * contained [TRUNCATED].
   *
   * Passed in and never recomputed, because only the caller holds the
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
   * `markdown` and claims no structure it did not derive.
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
    // previous hardcoded 0/false was a lie, not a simplification.
    redactionCount: input.redactionCount ?? 0,
    truncated: input.truncated ?? false,
    structuredData: summarizeStructuredData([]),
    title: input.title ?? null,
    contentType: input.contentType,
    bodySha256: input.bodySource === undefined ? textSha256 : await sha256Hex(input.bodySource),
    contentRegionSha256: '',
    textSha256,
    contentSimhash: simhash(input.text),
    httpEtag: input.etag ?? null,
    httpLastModified: input.lastModified ?? null,
    jsonLd: [],
    outboundHosts: [],
    links: [],
    lane: input.lane,
    rung: input.rung,
  };
}
