// ─── IP literal parsing + private-range classification ──────────────────────
//
// The shared address primitives behind BOTH the SSRF host guard
// (fetch/host-policy.ts) and URL safety checks (core/url-safety.ts). Keeping
// one copy of the classifier means a range added here covers both call sites.
//
// Everything is pure and synchronous: no DNS, no network. Resolution lives in
// host-policy.ts; this module only answers "what is this address, and is it
// one we must never let a crawler reach".

/** Hostnames that are never crawlable, regardless of what DNS says. */
const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', '127.0.0.1', '::1']);

/** Suffixes that denote a private/internal network namespace. */
const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localhost', '.localdomain'];

function isIpv4Literal(host: string): boolean {
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

function isIpv6Literal(host: string): boolean {
  // A dotted tail such as ::ffff:10.0.0.1 is not accepted here. The URL parser rewrites it to
  // hex, and isBlockedHostname refuses any other host that contains a colon.
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

/** Expands an IPv6 literal into its eight 16-bit groups, or null when it is not one. */
function ipv6Groups(host: string): number[] | null {
  if (!isIpv6Literal(host)) return null;
  const parts = (value: string) => (value ? value.split(':') : []).map((segment) => parseInt(segment, 16));
  if (!host.includes('::')) return parts(host);
  const [left, right] = host.split('::', 2);
  const head = parts(left ?? '');
  const tail = parts(right ?? '');
  return [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

function embeddedIpv4(high: number, low: number): string {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * Private, reserved or tunnelled IPv6. Besides loopback, unique-local, link-local, site-local,
 * multicast and documentation ranges, it refuses every form that carries an IPv4 address inside it:
 * IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), NAT64 (64:ff9b::/96 and 64:ff9b:1::/48),
 * 6to4 (2002::/16) and Teredo (2001::/32). The URL parser writes a mapped address in hex
 * ([::ffff:7f00:1] for 127.0.0.1), so the check reads the groups and not the dotted text. The
 * embedded IPv4 goes through isPrivateIpv4, and a literal this module cannot parse is refused.
 */
export function isPrivateIpv6(host: string): boolean {
  const g = ipv6Groups(host.toLowerCase());
  if (!g) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;

  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) {
    return g5 === 0 ? true : isPrivateIpv4(embeddedIpv4(g6, g7));
  }
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateIpv4(embeddedIpv4(g6, g7));
    if (g2 === 1) return true;
  }
  if (g0 === 0x2002) return isPrivateIpv4(embeddedIpv4(g1, g2));
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true;

  return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 || (g0 & 0xff00) === 0xff00;
}

/** A hostname that must never be fetched, before any DNS resolution. */
export function isBlockedHostname(hostname: string): boolean {
  // A trailing dot names the same host (localhost.), so it is dropped before matching.
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  // IPv6 URL hosts arrive bracketed (https://[::1]/) — unwrap before matching.
  const unwrapped = normalized.startsWith('[') && normalized.endsWith(']') ? normalized.slice(1, -1) : normalized;
  if (!unwrapped) return true;
  if (BLOCKED_HOSTNAMES.has(unwrapped)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => unwrapped.endsWith(suffix))) return true;
  // A bare integer is a valid-but-obfuscated IPv4 encoding (2130706433 ==
  // 127.0.0.1). Refuse it without decoding.
  if (/^[0-9]+$/.test(unwrapped)) return true;

  const version = getIpVersion(unwrapped);
  if (version === 4 && isPrivateIpv4(unwrapped)) return true;
  if (version === 6 && isPrivateIpv6(unwrapped)) return true;
  // Anything with a colon that is not a valid IPv6 literal is not a host name.
  if (version === 0 && unwrapped.includes(':')) return true;

  return false;
}
