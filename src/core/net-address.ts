// ─── IP literal parsing + private-range classification ──────────────────────
//
// The shared address primitives behind BOTH the SSRF host guard
// (fetch/host-policy.ts) and URL safety checks (core/url-safety.ts). In the
// repo this was extracted from, these ~110 lines existed TWICE — once in
// lib/ingestion/crawl-source-policy.ts and again in
// lib/security/input-validation.ts — with subtly different call sites. Two
// copies of a security classifier is one copy too many: a range added to one
// silently leaves the other exploitable. One home here, consumed by both.
//
// Everything is pure and synchronous: no DNS, no network. Resolution lives in
// host-policy.ts; this module only answers "what is this address, and is it
// one we must never let a crawler reach".

/** Hostnames that are never crawlable, regardless of what DNS says. */
export const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', '127.0.0.1', '::1']);

/** Suffixes that denote a private/internal network namespace. */
export const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localhost', '.localdomain'];

export function isIpv4Literal(host: string): boolean {
  if (!/^(\d{1,3})(?:\.(\d{1,3})){3}$/.test(host)) return false;
  return host.split('.').every((segment) => {
    const parsed = Number(segment);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255;
  });
}

function isValidIpv6Segment(segment: string): boolean {
  if (!segment) return false;
  return /^[0-9a-f]{1,4}$/i.test(segment);
}

export function isIpv6Literal(host: string): boolean {
  // NOTE: this rejects IPv4-mapped forms like ::ffff:10.0.0.1 because of the
  // '.' check. That is deliberate and load-bearing — see isPrivateIpv6's own
  // note. It means such an address is classified version 0 ("not an IP we
  // understand"), and every caller treats unknown as unsafe, so the mapped
  // form fails CLOSED rather than being parsed and possibly mis-allowed.
  if (host.includes('.')) return false;

  if (host.includes('::')) {
    const hasMultipleCompression = host.indexOf('::') !== host.lastIndexOf('::');
    if (hasMultipleCompression) return false;

    const [prefix, suffix] = host.split('::', 2);
    const leftParts = prefix ? prefix.split(':').filter((p) => p.length > 0) : [];
    const rightParts = suffix ? suffix.split(':').filter((p) => p.length > 0) : [];
    return leftParts.length + rightParts.length <= 7 && leftParts.every(isValidIpv6Segment) && rightParts.every(isValidIpv6Segment);
  }

  const segments = host.split(':');
  return segments.length === 8 && segments.every(isValidIpv6Segment);
}

/** 4, 6, or 0 for "not an IP literal we recognise". */
export function getIpVersion(host: string): 0 | 4 | 6 {
  if (isIpv4Literal(host)) return 4;
  if (isIpv6Literal(host)) return 6;
  return 0;
}

/**
 * Private, reserved, or otherwise non-public IPv4. Covers more than RFC1918
 * on purpose:
 *   0/8         this-network
 *   10/8        private
 *   100.64/10   carrier-grade NAT
 *   127/8       loopback
 *   169.254/16  link-local — INCLUDING 169.254.169.254, cloud instance
 *               metadata, which is the single highest-value SSRF target
 *   172.16/12   private
 *   192.168/16  private
 *   198.18/15   benchmarking
 *   224+        multicast and reserved
 */
export function isPrivateIpv4(host: string): boolean {
  const [a, b] = host.split('.').map((segment) => Number(segment));
  if (a === undefined || b === undefined || Number.isNaN(a) || Number.isNaN(b)) return false;

  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 169 && b === 254) ||
    a === 127 ||
    a >= 224
  );
}

/**
 * Private/reserved IPv6: loopback, unspecified, unique-local (fc00::/7),
 * link-local (fe80::/10), multicast (ff00::/8), and the documentation range.
 *
 * The `::ffff:` branch below is currently UNREACHABLE via getIpVersion(),
 * which rejects dotted addresses before this is consulted. Kept deliberately:
 * it is correct, it costs nothing, and it is the right behaviour if the
 * literal parser is ever taught to accept mapped forms. Today the mapped form
 * is refused earlier as "not a recognised address" — a different message, the
 * same safe outcome. Do NOT loosen isIpv6Literal to reach this branch: that
 * would widen input accepted by an SSRF guard to gain protection it already
 * has.
 */
export function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;

  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isIpv4Literal(mapped)) return isPrivateIpv4(mapped);
  }

  return (
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:')
  );
}

/** A hostname that must never be fetched, before any DNS resolution. */
export function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  // IPv6 URL hosts arrive bracketed (https://[::1]/) — unwrap before matching.
  const unwrapped = normalized.startsWith('[') && normalized.endsWith(']') ? normalized.slice(1, -1) : normalized;
  if (!unwrapped) return true;
  if (BLOCKED_HOSTNAMES.has(unwrapped)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => unwrapped.endsWith(suffix))) return true;
  // A bare integer is a valid-but-obfuscated IPv4 encoding (2130706433 ==
  // 127.0.0.1). Refuse rather than decode.
  if (/^[0-9]+$/.test(unwrapped)) return true;

  const version = getIpVersion(unwrapped);
  if (version === 4 && isPrivateIpv4(unwrapped)) return true;
  if (version === 6 && isPrivateIpv6(unwrapped)) return true;

  return false;
}
