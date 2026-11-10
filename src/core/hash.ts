// SHA-256 through WebCrypto, which Node, browsers and edge runtimes all provide. A runtime without it
// fails loudly, because a made-up hash would silently report every page as changed.
export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  // CI-NODE20-1: pass a freshly copied view, not `.buffer`. Under Node 20 and a jsdom test environment,
  // TextEncoder can hand back a foreign-realm Uint8Array whose ArrayBuffer fails webcrypto's brand check.
  const data = new Uint8Array(bytes.byteLength);
  data.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
