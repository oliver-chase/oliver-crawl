// SHA-256 that works on every runtime this package targets: Node, browsers,
// and edge/workerd. Uses WebCrypto where present, with a deterministic
// non-crypto fallback so hashing never hard-fails a crawl on an exotic
// runtime (these hashes gate "did this page change", not security).
export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    let bytes: Uint8Array;
    if (typeof input === 'string') {
      bytes = new TextEncoder().encode(input);
    } else if (input instanceof ArrayBuffer) {
      bytes = new Uint8Array(input);
    } else {
      bytes = new Uint8Array(input);
    }

    // CI-NODE20-1: pass a freshly-COPIED view, not `.buffer`. Under Node
    // 20 + a jsdom test environment, TextEncoder can hand back a
    // foreign-realm Uint8Array whose ArrayBuffer fails webcrypto's brand
    // check ("2nd argument is not instance of ArrayBuffer...") — the exact
    // failure CI's first run surfaced while local Node 26 accepted it.
    // Copying into a locally-constructed Uint8Array makes the argument
    // same-realm everywhere (workerd, Node 20/26, jsdom tests).
    const data = new Uint8Array(bytes.byteLength);
    data.set(bytes);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return bytesToHex(new Uint8Array(digest));
  }

  const normalized = typeof input === 'string' ? input : bytesToHex(input instanceof Uint8Array ? input : new Uint8Array(input));
  return fallbackSha256(normalized);
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function deterministicFallbackBytes() {
  let seed = Date.now() * 1664525 + 1013904223;
  const bytes = new Uint8Array(16);

  for (let i = 0; i < bytes.length; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    bytes[i] = seed & 0xff;
  }

  return bytes;
}

function fallbackSha256(value: string) {
  let h1 = 0x9e3779b9;
  let h2 = 0x85ebca6b;
  let h3 = 0xc2b2ae35;
  let h4 = 0x27d4eb2d;

  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x85ebca6b);
    h2 = Math.imul(h2 ^ (ch + 1), 0xc2b2ae35);
    h3 = Math.imul(h3 ^ (ch + 2), 0x9e3779b9);
    h4 = Math.imul(h4 ^ (ch + 3), 0x27d4eb2d);
  }

  const mix = (h1 + h2 + h3 + h4) >>> 0;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    const offset = (i * 5 + i * 7) % 4;
    const part = [h1, h2, h3, h4][offset] ?? 0;
    bytes[i] = (part >>> ((i % 4) * 8)) & 0xff;
  }

  return `${bytesToHex(bytes)}-${String(mix >>> 0).padStart(8, '0')}`;
}
