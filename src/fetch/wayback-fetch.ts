// ─── Internet Archive fallback rung (free) ──────────────────────────────────
//
// WAYBACK-RUNG-1 (2026-07-27). When every live rung fails for TRANSPORT
// reasons — the host is down, DNS is failing, the origin times out — the page
// often still exists in the Internet Archive. The CDX API is free, keyless,
// and public, which makes this a legitimate free rung rather than another
// vendor.
//
// ── The gate, which matters more than the feature ──
//
// This rung runs ONLY when robots posture is explicitly `allow`.
//
// That restriction is the whole design. An archive fallback is trivially a way
// to read pages a site refused us, and building that would make every other
// guard in this package decorative. So:
//
//   disallow  — never. The site said no; reading a copy is still reading it.
//   unknown   — never. We fail closed on unknown everywhere else, and an
//               archive is not a way to launder an unresolved posture.
//   allow     — yes, and only after the live rungs have failed.
//
// It is also last by construction: an archived copy is by definition older
// than the live page, so preferring it to a live fetch would silently serve
// stale data. It runs when the alternative is nothing at all.

/** CDX index: which snapshots exist, newest first, successful captures only. */
const CDX_ENDPOINT = 'https://web.archive.org/cdx/search/cdx';
/** `id_` returns the ORIGINAL bytes without the Archive's toolbar injection. */
const SNAPSHOT_PREFIX = 'https://web.archive.org/web/';
const WAYBACK_TIMEOUT_MS = 20_000;
const WAYBACK_MAX_BYTES = 2_000_000;

export type WaybackResult =
  | { ok: true; html: string; capturedAt: string; snapshotUrl: string }
  | { ok: false; detail: string };

/**
 * Fetch the most recent successful archived capture of a URL.
 *
 * Returns `ok: false` rather than throwing for every failure mode — no
 * snapshot exists, the archive is unreachable, the capture is unusable. This
 * is a last rung, and a last rung that throws would convert "we could not
 * read the page" into "the crawl crashed".
 */
export async function fetchViaWayback(
  targetUrl: string,
  opts?: { fetchImpl?: typeof fetch; maxAgeDays?: number },
): Promise<WaybackResult> {
  const doFetch = opts?.fetchImpl ?? fetch;

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return { ok: false, detail: 'Unparseable URL.' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, detail: 'Only http(s) URLs can be looked up in the archive.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WAYBACK_TIMEOUT_MS);

  try {
    const query = new URL(CDX_ENDPOINT);
    query.searchParams.set('url', targetUrl);
    query.searchParams.set('output', 'json');
    query.searchParams.set('limit', '1');
    // Successful captures only: the archive faithfully stores 404 pages too,
    // and returning an archived 404 as content would be worse than nothing.
    query.searchParams.set('filter', 'statuscode:200');
    query.searchParams.set('sort', 'reverse');
    query.searchParams.set('fl', 'timestamp,original');

    const indexRes = await doFetch(query.toString(), { signal: controller.signal });
    if (!indexRes.ok) return { ok: false, detail: `Archive index returned ${indexRes.status}.` };

    const rows = (await indexRes.json()) as string[][];
    // Row 0 is the header; a bare header means no capture exists.
    const row = rows?.[1];
    const timestamp = row?.[0];
    if (!timestamp) return { ok: false, detail: 'No archived capture of this URL.' };

    const capturedAt = toIsoDate(timestamp);
    const maxAgeDays = opts?.maxAgeDays;
    if (maxAgeDays !== undefined && capturedAt) {
      const ageDays = (Date.now() - Date.parse(capturedAt)) / 86_400_000;
      if (ageDays > maxAgeDays) {
        return { ok: false, detail: `Newest capture is ${Math.round(ageDays)} days old (limit ${maxAgeDays}).` };
      }
    }

    const snapshotUrl = `${SNAPSHOT_PREFIX}${timestamp}id_/${targetUrl}`;
    const snapshotRes = await doFetch(snapshotUrl, { signal: controller.signal });
    if (!snapshotRes.ok) return { ok: false, detail: `Archived capture returned ${snapshotRes.status}.` };

    const html = (await snapshotRes.text()).slice(0, WAYBACK_MAX_BYTES);
    if (!html.trim()) return { ok: false, detail: 'Archived capture was empty.' };

    return { ok: true, html, capturedAt: capturedAt ?? timestamp, snapshotUrl };
  } catch (error) {
    return { ok: false, detail: `Archive lookup failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timeout);
  }
}

/** CDX stamps are `YYYYMMDDhhmmss`. */
function toIsoDate(timestamp: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(timestamp);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}
