// Pure hashing + seeded-randomness primitives for the copywriting engine
// (Module 4). No IO, no server-only - tests, the client Studio and both
// runtimes import freely.
//
// Design constraints (owner P1): Redis stores ONLY compact signatures, never
// raw text - a 64-bit SimHash captures the message's structural skeleton
// (word-trigram shingles), and a 32-bit FNV-1a of the normalized text catches
// exact duplicates. Both fit one ~24-char ZSET member.

/** FNV-1a 32-bit - fast, stable, good avalanche for short strings. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (keeps it in uint32 without BigInt).
    h = (h + ((h << 1) >>> 0) + ((h << 4) >>> 0) + ((h << 7) >>> 0) + ((h << 8) >>> 0) + ((h << 24) >>> 0)) >>> 0;
  }
  return h >>> 0;
}

/** FNV-1a 64-bit (BigInt) - used to hash individual shingles for SimHash. */
export function fnv1a64(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h;
}

/** Normalize for structural comparison: lowercase, letters/digits/spaces only. */
export function normalizeForSig(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Word-trigram shingles (bigrams for very short texts) - the same skeleton
 * unit the existing trigramOverlap uses, so both layers agree on "similar". */
export function shingles(s: string): string[] {
  const words = normalizeForSig(s).split(" ").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length - 2; i++) out.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  if (out.length === 0) {
    for (let i = 0; i < words.length - 1; i++) out.push(`${words[i]} ${words[i + 1]}`);
  }
  return out;
}

/**
 * 64-bit SimHash over word-trigram shingles. Structurally similar messages
 * land within a small Hamming distance; a reworded skeleton flips many bits.
 */
export function simhash64(text: string): bigint {
  const grams = shingles(text);
  if (grams.length === 0) return fnv1a64(normalizeForSig(text));
  const weights = new Array<number>(64).fill(0);
  for (const g of grams) {
    const h = fnv1a64(g);
    for (let bit = 0; bit < 64; bit++) {
      weights[bit] += (h >> BigInt(bit)) & 1n ? 1 : -1;
    }
  }
  let out = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (weights[bit] > 0) out |= 1n << BigInt(bit);
  }
  return out;
}

/** Hamming distance between two 64-bit hashes (0 = identical skeleton). */
export function hamming64(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}

/** The compact ZSET member: simhash64 hex (16) + fnv1a32 hex (8) = 24 chars. */
export function copySignature(text: string): string {
  const sim = simhash64(text).toString(16).padStart(16, "0");
  const exact = fnv1a32(normalizeForSig(text)).toString(16).padStart(8, "0");
  return `${sim}${exact}`;
}

/** Parse a stored member back into its two hashes (tolerates junk -> null). */
export function parseSignature(member: string): { sim: bigint; exact: string } | null {
  if (!/^[0-9a-f]{24}$/.test(member)) return null;
  return { sim: BigInt(`0x${member.slice(0, 16)}`), exact: member.slice(16) };
}

/**
 * mulberry32 - the tiny deterministic PRNG behind the whole variation matrix:
 * seed with fnv1a32(threadId|vendorId|nonce) and every pool pick reproduces
 * exactly (owner P2: reproducible diversity, testable end to end).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
