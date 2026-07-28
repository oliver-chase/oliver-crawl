// ─── LANE 2: the vendor lane ────────────────────────────────────────────────
//
// Third-party scraping APIs, behind one interface. This lane exists for the
// cases the own lane genuinely cannot serve — a page that requires executing
// JavaScript, or an origin that hard-blocks direct crawling — and for nothing
// else. It is OFF by default: a caller gets it only by asking for it in
// `lanes`, so no consumer of this package ever pays a vendor by accident.
//
// Every rung is optional and independent:
//   - a missing key disables THAT rung and nothing else
//   - no keys at all means the lane reports 'no_lane_available' rather than
//     throwing, so "vendor configured" is a runtime fact a consumer can
//     branch on, not a deployment precondition
//   - each paid call is gated on checkBudget() first, so a consumer's own
//     spend cap is enforced here without this package knowing what a budget is
//
// Adding a vendor means adding one VendorRung and a key — call sites,
// budgeting, and usage reporting need no changes.

import { availableVendorRungs } from '../../core/config.js';
import { emitUsage } from '../../core/usage.js';
import { sanitizeCrawledText } from '../../guard/prompt-injection-guard.js';
import { buildTextPage } from '../../fetch/build-page.js';
import type { ResolvedConfig } from '../../core/config.js';
import type { CrawlOptions, CrawlResult } from '../../core/types.js';

/** One vendor integration. Returns null to mean "I could not serve this",
 *  which lets the lane try the next rung; it throws only on real errors. */
type VendorRung = {
  name: string;
  /** Key present? Checked before the rung is attempted. */
  isConfigured: (config: ResolvedConfig) => boolean;
  /** Vendors bill per call — every rung here is paid unless stated. */
  paid: boolean;
  scrape: (url: string, config: ResolvedConfig, timeoutMs: number) => Promise<{ text: string; title: string | null } | null>;
};

const FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev/v1/scrape';

const firecrawlRung: VendorRung = {
  name: 'firecrawl',
  paid: true,
  isConfigured: (config) => Boolean(config.vendor?.firecrawl),
  async scrape(url, config, timeoutMs) {
    const response = await fetch(FIRECRAWL_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.vendor?.firecrawl}`,
      },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      // Surface the vendor's own message — "Key limit exceeded" and "invalid
      // key" are operationally different and a bare status code hides that.
      const body = await response.text().catch(() => '');
      throw new Error(`Firecrawl HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as { data?: { markdown?: string; text?: string; metadata?: { title?: string } } };
    const text = data.data?.markdown || data.data?.text || '';
    if (!text.trim()) return null;
    return { text, title: data.data?.metadata?.title ?? null };
  },
};

const APIFY_BASE = 'https://api.apify.com/v2';

/** Apify's generic web scraper. Slower and heavier than Firecrawl; kept as a
 *  second rung because it succeeds on some sites Firecrawl does not. */
const apifyRung: VendorRung = {
  name: 'apify',
  paid: true,
  isConfigured: (config) => Boolean(config.vendor?.apify),
  async scrape(url, config, timeoutMs) {
    const token = config.vendor?.apify;
    const response = await fetch(`${APIFY_BASE}/acts/apify~website-content-crawler/run-sync-get-dataset-items?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startUrls: [{ url }], maxCrawlPages: 1, crawlerType: 'playwright:firefox' }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Apify HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const items = (await response.json()) as Array<{ text?: string; markdown?: string; metadata?: { title?: string } }>;
    const first = Array.isArray(items) ? items[0] : undefined;
    const text = first?.markdown || first?.text || '';
    if (!text.trim()) return null;
    return { text, title: first?.metadata?.title ?? null };
  },
};

const RUNGS: Record<string, VendorRung> = {
  firecrawl: firecrawlRung,
  apify: apifyRung,
};

/**
 * Scrape one URL through the vendor lane, trying configured rungs in order.
 *
 * Note what this does NOT do, deliberately: it applies no DNS/SSRF check of
 * its own, because the request is made by the VENDOR from the vendor's own
 * infrastructure — our network is never the one connecting.
 *
 * Same-site, eligibility and robots ARE enforced, lane-independently, by
 * crawl() (VENDOR-POLICY-1) — governance is a property of the crawl, not of
 * which network makes the request. Callers invoking this function directly
 * bypass that gate and take on the vetting themselves.
 */
export async function crawlWithVendorLane(
  url: string,
  config: ResolvedConfig,
  options: CrawlOptions = {},
): Promise<CrawlResult> {
  const timeoutMs = options.timeoutMs ?? config.defaults.timeoutMs;
  const maxTextChars = options.maxTextChars ?? config.defaults.maxTextChars;
  const usable = availableVendorRungs(config);

  if (usable.length === 0) {
    return {
      ok: false,
      reason: 'no_lane_available',
      detail: 'Vendor lane requested but no vendor API key is configured. Set one (e.g. FIRECRAWL_API_KEY) or use the own lane.',
      lane: 'vendor',
    };
  }

  let lastDetail = 'no vendor rung produced content';

  for (const rungName of usable) {
    const rung = RUNGS[rungName];
    if (!rung || !rung.isConfigured(config)) continue;

    // A consumer's spend cap is enforced here, before the paid call.
    if (rung.paid && config.checkBudget) {
      const allowed = await config.checkBudget();
      if (!allowed) {
        // BREAK, not continue: the budget is a GLOBAL cap, so if it refuses
        // one paid rung it will refuse every other one too. Continuing just
        // re-asked the same question per rung and reported the last rung's
        // name instead of the real reason.
        lastDetail = 'budget check refused the paid vendor call';
        break;
      }
    }

    const started = Date.now();
    try {
      const result = await rung.scrape(url, config, timeoutMs);
      if (!result) {
        lastDetail = `${rungName} returned no content`;
        emitUsage(config, { lane: 'vendor', rung: rungName, kind: 'scrape', url, ok: false, latencyMs: Date.now() - started, error: lastDetail });
        continue;
      }

      // Vendor output is page content too — it gets the same guard.
      const sanitized = sanitizeCrawledText(result.text, maxTextChars);
      if (sanitized.signals.length > 0) {
        emitUsage(config, { lane: 'vendor', rung: rungName, kind: 'scrape', url, ok: false, latencyMs: Date.now() - started, error: 'quarantined' });
        // QUARANTINE-EVIDENCE-1: same evidence the own lane returns. A paid
        // page that trips the guard is still a page a consumer must be able to
        // review rather than silently drop.
        return {
          ok: false,
          reason: 'quarantined',
          detail: `Prompt-injection signals in ${rungName} content.`,
          lane: 'vendor',
          quarantine: { signals: sanitized.signals, text: sanitized.text, title: null },
        };
      }

      emitUsage(config, { lane: 'vendor', rung: rungName, kind: 'scrape', url, ok: true, latencyMs: Date.now() - started });
      return {
        ok: true,
        pages: [
          await buildTextPage({
            url,
            text: sanitized.text,
            contentKind: 'html',
            contentType: 'text/markdown',
            rung: rungName,
            lane: 'vendor',
            title: result.title,
            bodySource: result.text,
            // Both vendor rungs are ASKED for markdown, so the delivered text
            // already is markdown — same value, not a second conversion.
            markdown: sanitized.text,
          }),
        ],
      };
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
      emitUsage(config, { lane: 'vendor', rung: rungName, kind: 'scrape', url, ok: false, latencyMs: Date.now() - started, error: lastDetail });
      // Try the next rung — a vendor outage should not end the crawl.
    }
  }

  return { ok: false, reason: 'unreachable', detail: lastDetail, lane: 'vendor' };
}

