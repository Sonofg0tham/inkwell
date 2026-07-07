/**
 * Fast synchronous string hashing (double FNV-1a, 64 bits combined).
 * Used for chunk identity and cache keys — not security-sensitive.
 * crypto.subtle is unavailable on plain-http pages, so this must stay sync.
 */
export function fnvHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c;
    h2 = Math.imul(h2, 0x01000197) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
