// Global message uniqueness - at hundreds of users, no two shops may ever
// receive the same sentence, even across DIFFERENT users. The per-thread
// dedupe (guardOutbound) and the per-user anti-repetition list already exist;
// this is the cross-user layer: a trigram-overlap check against the app's
// recent outbound messages, with a deterministic re-variation fallback when a
// draft collides.

function trigrams(s: string): Set<string> {
  const norm = s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const words = norm.split(" ").filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i < words.length - 2; i++) {
    grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  // Very short messages: fall back to word bigrams so they still compare.
  if (grams.size === 0) {
    for (let i = 0; i < words.length - 1; i++) grams.add(`${words[i]} ${words[i + 1]}`);
  }
  return grams;
}

export function trigramOverlap(a: string, b: string): number {
  const ga = trigrams(a);
  const gb = trigrams(b);
  if (ga.size === 0 || gb.size === 0) {
    return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  }
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return hit / Math.min(ga.size, gb.size);
}

const EMOJI_POOL = ["🙂", "🙏", "🤙", "😊", "🫶", "👌", "🤝"];
const OPENER_SWAPS: [RegExp, string[]][] = [
  [/^okay\b/i, ["Ok", "Alright", "Sounds good", "Got it"]],
  [/^ok\b/i, ["Okay", "Alright", "Cool", "Got it"]],
  [/^great\b/i, ["Nice", "Perfect", "Awesome", "Sounds good"]],
  [/^thanks\b/i, ["Thank you", "Appreciate it", "Thanks a lot", "Ta"]],
];

/** Seeded variant of revary (Module 4): deterministic given an rng, so the
 * compiler's collision re-variation is replayable and unit-testable. */
export function revarySeeded(text: string, rng: () => number): string {
  let out = text;
  for (const [rx, pool] of OPENER_SWAPS) {
    if (rx.test(out)) {
      out = out.replace(rx, pool[Math.floor(rng() * pool.length)]);
      break;
    }
  }
  const emojiRx = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  const fresh = EMOJI_POOL[Math.floor(rng() * EMOJI_POOL.length)];
  out = emojiRx.test(out) ? out.replace(emojiRx, fresh) : `${out} ${fresh}`;
  if (rng() < 0.5) out = out.replace(/\bcan you\b/i, (m) => (m[0] === "C" ? "Could you" : "could you"));
  if (rng() < 0.4) out = out.replace(/!$/, ".");
  return out;
}

/** Deterministic mutation used when a draft collides globally. */
export function revary(text: string): string {
  let out = text;
  for (const [rx, pool] of OPENER_SWAPS) {
    if (rx.test(out)) {
      out = out.replace(rx, pool[Math.floor(Math.random() * pool.length)]);
      break;
    }
  }
  // Swap the emoji (or add one) - changes the payload without the meaning.
  const emojiRx = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  const fresh = EMOJI_POOL[Math.floor(Math.random() * EMOJI_POOL.length)];
  out = emojiRx.test(out) ? out.replace(emojiRx, fresh) : `${out} ${fresh}`;
  // Light punctuation/wording jitter.
  if (Math.random() < 0.5) out = out.replace(/\bcan you\b/i, (m) => (m[0] === "C" ? "Could you" : "could you"));
  if (Math.random() < 0.4) out = out.replace(/!$/, ".");
  return out;
}

export interface FreshnessVerdict {
  text: string;
  changed: boolean;
  maxOverlap: number;
}

/**
 * Ensure the draft is globally fresh: compare against the app's recent
 * outbound bodies (ALL users); above the threshold, mutate deterministically
 * up to 3 times until it clears (or ship the best attempt - a near-miss after
 * mutation still hashes differently thanks to humanizeVariant downstream).
 */
export function ensureGloballyFresh(
  draft: string,
  recentGlobal: string[],
  threshold = 0.75
): FreshnessVerdict {
  let text = draft;
  let changed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let max = 0;
    for (const prior of recentGlobal) {
      const o = trigramOverlap(text, prior);
      if (o > max) max = o;
      if (max >= 1) break;
    }
    if (max < threshold) return { text, changed, maxOverlap: max };
    text = revary(text);
    changed = true;
  }
  let final = 0;
  for (const prior of recentGlobal) final = Math.max(final, trigramOverlap(text, prior));
  return { text, changed, maxOverlap: final };
}

// ---------------------------------------------------------------------------
// Redis signature window (Module 4, owner P1) - the memory-optimized global
// recent-send memory. ONE ZSET `copy:sigs` holding compact 24-char members
// (simhash64 hex + fnv1a32 hex - see copy/hash.ts), score = timestamp,
// trimmed to SIG_CAP by rank + 48h EXPIRE: ~200KB worst case, never raw text.
// REDIS_URL-gated via the shared hot-state client - a strict no-op on Vercel,
// where the DB-based ensureGloballyFresh above remains the only layer.
// ---------------------------------------------------------------------------

import { copySignature, parseSignature, hamming64, simhash64, mulberry32, fnv1a32 } from "../copy/hash";
import { hotStateClient } from "../rival-cache";

const SIG_KEY = "copy:sigs";
const SIG_CAP = 2000; // ~2000 * ~100B (member+overhead) ≈ 200KB - far under budget
const SIG_TTL_S = 48 * 3600;
const SIG_WINDOW = 300; // compare vs the most recent N signatures (one ZRANGE)
const HAMMING_MAX = 10; // ≤10/64 differing bits = same structural skeleton

/** Record an ACCEPTED outbound's signature in the sliding window. No-op on
 * Vercel; never throws. */
export async function recordCopySignature(text: string): Promise<void> {
  try {
    const r = await hotStateClient();
    if (!r) return;
    await r.zadd(SIG_KEY, String(Date.now()), copySignature(text));
    await r.zremrangebyrank(SIG_KEY, 0, -(SIG_CAP + 1)); // keep newest SIG_CAP
    await r.expire(SIG_KEY, SIG_TTL_S);
  } catch {
    /* the guard is an enhancement - a Redis blip never blocks a send */
  }
}

/** True when the candidate's skeleton collides with a recent global send. */
async function collidesGlobally(text: string): Promise<boolean> {
  try {
    const r = await hotStateClient();
    if (!r) return false; // Vercel / Redis down -> the DB layer already ran
    const sim = simhash64(text);
    const exact = copySignature(text).slice(16);
    const recent = await r.zrange(SIG_KEY, -SIG_WINDOW, -1);
    for (const member of recent) {
      const parsed = parseSignature(member);
      if (!parsed) continue;
      if (parsed.exact === exact) return true; // exact duplicate
      if (hamming64(parsed.sim, sim) <= HAMMING_MAX) return true; // same skeleton
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * The full global-uniqueness gate (Module 4): the in-process trigram check vs
 * the caller's recent list (works everywhere) PLUS the Redis signature window
 * (worker runtime). Collisions re-vary DETERMINISTICALLY (seeded by the text
 * itself) up to 3 times; the accepted text's signature is recorded so the next
 * send anywhere in the fleet sees it.
 */
export async function ensureGloballyUnique(
  draft: string,
  recentFallback: string[],
  opts: { threshold?: number; record?: boolean } = {}
): Promise<FreshnessVerdict> {
  // Layer 1: the existing in-process compare (raw strings, DB-fed).
  let verdict = ensureGloballyFresh(draft, recentFallback, opts.threshold ?? 0.75);
  // Layer 2: the cross-fleet signature window.
  const rng = mulberry32(fnv1a32(draft));
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await collidesGlobally(verdict.text))) break;
    verdict = { text: revarySeeded(verdict.text, rng), changed: true, maxOverlap: verdict.maxOverlap };
  }
  if (opts.record !== false) await recordCopySignature(verdict.text);
  return verdict;
}

const EMOJI_ANY = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]/u;

/**
 * Emoji tone: outbound messages carry EXACTLY one warm emoji (kindness is
 * policy; the composer prompts say "max one"). Adds one when missing; trims
 * every extra beyond the first so the message never reads as emoji spam.
 */
export function enforceEmojiTone(text: string, enabled: boolean): string {
  if (!enabled) return text;
  if (!EMOJI_ANY.test(text)) {
    const fresh = EMOJI_POOL[Math.floor(Math.random() * EMOJI_POOL.length)];
    return `${text.replace(/\s+$/, "")} ${fresh}`;
  }
  // Keep only the FIRST emoji - models sometimes stack two or three.
  const all = [...text.matchAll(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]/gu)];
  if (all.length > 1) {
    let seen = 0;
    return text
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]/gu, (m) => (++seen <= 1 ? m : ""))
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  return text;
}
