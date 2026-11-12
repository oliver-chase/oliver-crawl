// ─── Near-duplicate fingerprint ─────────────────────────────────────────────
//
// CRAWL-NEARDUP-1: the same article under two URLs (a print view, a tracking
// variant, a mirrored category path) is different bytes and so a different
// hash, yet it is one page for every downstream purpose. A SimHash of the
// delivered text puts those pages a few bits apart, which `crawlSite` uses to
// report the second as a duplicate and spare the extraction that would follow.
//
// Pure arithmetic: no model, no network, no dependency. 64 bits, written as
// 16 hex characters so a consumer can store it and compare across runs.

/** Pages with fewer words than this get no fingerprint: a short page shares too much template text. */
const NEAR_DUPLICATE_MIN_WORDS = 60;

const MAX_WORDS = 5000;
const SHINGLE = 3;

function fnv32(text: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // murmur3 finaliser, so neighbouring shingles do not share high bits
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, MAX_WORDS);
}

/** The fingerprint of some text, or '' when it is too short to compare. */
export function simhash(text: string): string {
  const tokens = words(text);
  if (tokens.length < NEAR_DUPLICATE_MIN_WORDS) return '';
  const votes = new Array<number>(64).fill(0);
  for (let i = 0; i + SHINGLE <= tokens.length; i++) {
    const shingle = tokens.slice(i, i + SHINGLE).join(' ');
    const lo = fnv32(shingle, 2166136261);
    const hi = fnv32(shingle, 0x9747b28c);
    for (let bit = 0; bit < 32; bit++) {
      votes[bit]! += (lo >>> bit) & 1 ? 1 : -1;
      votes[32 + bit]! += (hi >>> bit) & 1 ? 1 : -1;
    }
  }
  let lo = 0;
  let hi = 0;
  for (let bit = 0; bit < 32; bit++) {
    if (votes[bit]! > 0) lo |= 1 << bit;
    if (votes[32 + bit]! > 0) hi |= 1 << bit;
  }
  return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

function popcount(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Number of differing bits between two fingerprints. */
export function hammingDistance(a: string, b: string): number {
  const hi = (parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0;
  const lo = (parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16)) >>> 0;
  return popcount(hi) + popcount(lo);
}

/**
 * Finds an earlier fingerprint within `maxDistance` bits without comparing against every page.
 * The 64 bits split into four 16-bit bands, and two fingerprints at most 3 bits apart must agree
 * on at least one whole band, so a lookup touches only pages that share a band. A larger
 * distance falls back to a full scan, which stays correct and is only slower.
 */
export function createNearDuplicateIndex(maxDistance: number) {
  const seen: { url: string; hash: string }[] = [];
  const bands = new Map<string, number[]>();
  const bandKeys = (hash: string) => [0, 1, 2, 3].map((band) => `${band}:${hash.slice(band * 4, band * 4 + 4)}`);

  return {
    /** Records the page, or returns the earlier page it duplicates. */
    check(url: string, hash: string): { of: string; distance: number } | null {
      if (!hash || maxDistance < 0) return null;
      const candidates =
        maxDistance <= 3
          ? new Set(bandKeys(hash).flatMap((key) => bands.get(key) ?? []))
          : new Set(seen.keys());
      let best: { of: string; distance: number } | null = null;
      for (const index of candidates) {
        const prior = seen[index]!;
        const distance = hammingDistance(hash, prior.hash);
        if (distance <= maxDistance && (!best || distance < best.distance)) best = { of: prior.url, distance };
      }
      if (best) return best;
      seen.push({ url, hash });
      for (const key of bandKeys(hash)) {
        const list = bands.get(key);
        if (list) list.push(seen.length - 1);
        else bands.set(key, [seen.length - 1]);
      }
      return null;
    },
  };
}
