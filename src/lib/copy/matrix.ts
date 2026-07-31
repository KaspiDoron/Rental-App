// The VARIATION MATRIX (Module 4, owner P2) - pure, deterministic pools across
// independent structural dimensions. A message's shape is chosen by a seeded
// PRNG (mulberry32 over fnv1a32(threadId|vendorId|nonce)), so:
//   - the SAME seed always compiles the SAME text (replayable, testable),
//   - DIFFERENT vendors get structurally different skeletons (anti-fingerprint),
//   - no Math.random anywhere - golden replay and unit tests stay bit-stable.
//
// Register: friendly traveller texting on the go - short, warm, non-native-
// tolerant English. Slang is LIGHT and respectful (a polite word, never a
// costume). Every pool entry must read naturally on its own.

import { fnv1a32, mulberry32 } from "./hash";
import type { ShopRegion } from "./region";

export interface CopySeed {
  threadId: string;
  vendorId: string;
  /** Varies per attempt/round so a re-compile shifts shape deterministically. */
  nonce: string | number;
}

/** The one seed derivation every caller shares. */
export function seedRng(seed: CopySeed): () => number {
  return mulberry32(fnv1a32(`${seed.threadId}|${seed.vendorId}|${seed.nonce}`));
}

/** Convenience for the cold-outreach path. */
export function openerSeed(userEmail: string, vendorId: string, nonce: string | number): CopySeed {
  return { threadId: userEmail, vendorId, nonce };
}

export function seededPick<T>(rng: () => number, pool: readonly T[]): T {
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

export function seededShuffle<T>(rng: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pools - independent dimensions. Adding entries GROWS the combination space
// multiplicatively (currently > 6 * 5 * 6 * 5 * 6 * 5 * 3 ~ 40k skeletons
// before emoji/slang/contraction variation).
// ---------------------------------------------------------------------------

export const GREETINGS = [
  "Hi!",
  "Hello!",
  "Hey!",
  "Good day!",
  "Hi there!",
  "Hello there!",
] as const;
// NOTE: region-specific greetings (e.g. the PH "po" particle) are NOT in this
// pool - they are region-keyed and applied by the compiler, so a Vietnam shop
// never receives a Filipino particle. See REGION_FLAVOR below.

export const SELF_INTROS = [
  "I'm visiting for a few days and",
  "I'm in town and",
  "I just got here and",
  "I'm staying nearby and",
  "Me and my partner are around and",
  "", // no intro - straight to the point (a real texting style)
] as const;

/**
 * Correct indefinite article for the vehicle phrase. Every template below
 * hardcoded "a", so the single most common request in this app - an AUTOMATIC
 * scooter - went out to real shops as "a automatic scooter". Sound, not
 * spelling, decides: "an 11-seater" but "a 125cc".
 */
export function article(word: string): "a" | "an" {
  const w = (word || "").trim().toLowerCase();
  if (!w) return "a";
  // Leading digits are read aloud: 8/11/18 take "an", everything else "a".
  const digits = w.match(/^(\d+)/)?.[1];
  if (digits) return /^(8|11|18)/.test(digits) ? "an" : "a";
  return /^[aeiou]/.test(w) ? "an" : "a";
}

export const VEHICLE_PHRASINGS = [
  (v: string) => `looking to rent ${article(v)} ${v}`,
  (v: string) => `need ${article(v)} ${v}`,
  (v: string) => `hoping to get ${article(v)} ${v}`,
  (v: string) => `after ${article(v)} ${v}`,
  (v: string) => `want to rent ${article(v)} ${v}`,
  (v: string) => `looking for ${article(v)} ${v} to rent`,
] as const;

export const DURATION_PHRASINGS = [
  (d: number) => `for ${d} days`,
  (d: number) => `for about ${d} days`,
  (d: number) => `${d} days total`,
  (d: number) => `for the next ${d} days`,
  (d: number) => `for ${d} days straight`,
] as const;

export const ASK_PHRASINGS = [
  "How much per day, best price?",
  "What's your best daily rate?",
  "How much would that be per day?",
  "What's the best you can do per day?",
  "Can I ask your daily price?",
  "What would it cost per day?",
] as const;

/**
 * The traveller asked for something beyond the vehicle - a child seat, a phone
 * mount, a top box. It reached the RFQ and then died there.
 *
 * The builder's free-text field folded into `notes`, which `buildMessage`
 * never reads; `accessories` was hard-coded `[]`; and the opener is REPLACED
 * server-side by compileOpener, which rendered vehicle and duration and
 * nothing else. Three separate places for the same request to vanish, so a
 * traveller who typed "child seat" got a message that never mentioned one.
 */
export const EXTRAS_PHRASINGS = [
  (x: string) => `Would you have ${x} too?`,
  (x: string) => `I'd also need ${x}.`,
  (x: string) => `Also looking for ${x} if you have it.`,
  (x: string) => `And ${x} if possible.`,
] as const;

export const SIGN_OFFS = [
  "Thanks!",
  "Thank you!",
  "Thanks a lot!",
  "Cheers!",
  "", // no sign-off
] as const;
// NOTE: "Salamat!" (a PH THANK-YOU) is region-keyed in REGION_FLAVOR, not in the
// neutral pool - it must never land region-blind on a non-PH shop.

/** Region flavor, correctly split into two grammatical roles:
 *   - `particles`: politeness particles that attach to a GREETING ("po", the
 *     gendered Thai "krub"/"ka"). Vietnam/Indonesia have none.
 *   - `thanks`: a local THANK-YOU that can only ever replace a terminal sign-off
 *     (never glued onto a greeting). Thai thanks is index-paired with the
 *     particle so the gender agrees within a message.
 * Diacritics are authored correctly. */
export interface RegionFlavor {
  particles: readonly string[];
  thanks: readonly string[];
}
export const REGION_FLAVOR: Record<ShopRegion, RegionFlavor> = {
  philippines: { particles: ["po"], thanks: ["Salamat!"] },
  thailand: { particles: ["krub", "ka"], thanks: ["Khop khun krub!", "Khop khun ka!"] }, // index-paired by gender
  vietnam: { particles: [], thanks: ["Cảm ơn!"] },
  indonesia: { particles: [], thanks: ["Terima kasih!"] },
};
function regionKeyOf(region?: string): ShopRegion | undefined {
  const k = (region ?? "").toLowerCase();
  return (["philippines", "thailand", "vietnam", "indonesia"] as ShopRegion[]).find((r) =>
    k.includes(r)
  );
}

export const CONTRACTION_STYLES = ["contracted", "plain", "mixed"] as const;
export type ContractionStyle = (typeof CONTRACTION_STYLES)[number];

export const EMOJIS = ["🙂", "🙏", "😊", "🤙", "👌", ""] as const; // "" = no emoji

/** Sentence-order templates for the opener skeleton. */
export const SENTENCE_ORDERS = ["greet-intro-ask", "greet-ask-intro", "intro-first"] as const;
export type SentenceOrder = (typeof SENTENCE_ORDERS)[number];

export interface StyleChoice {
  greeting: string;
  selfIntro: string;
  vehiclePhrase: (v: string) => string;
  durationPhrase: (d: number) => string;
  ask: string;
  /** How the traveller's extras are asked for, when there are any. */
  extrasPhrase: (x: string) => string;
  signOff: string;
  emoji: string;
  order: SentenceOrder;
  contraction: ContractionStyle;
  /** A greeting particle (po / krub / ka) for the shop's region, or undefined. */
  particle: string | undefined;
  /** A local thank-you (Salamat! / Cảm ơn! / gender-matched Thai), or undefined.
   * ONLY ever used in the terminal sign-off slot - never on a greeting. */
  regionalThanks: string | undefined;
}

/** Draw one full style combination from the matrix - pure + deterministic. */
export function drawStyle(seed: CopySeed, region?: string): StyleChoice {
  const rng = seedRng(seed);
  const flavor = (() => {
    const key = regionKeyOf(region);
    return key ? REGION_FLAVOR[key] : undefined;
  })();

  // The particle is pinned to a NONCE-FREE seed so it never flips mid-thread
  // (critical for the gendered Thai krub/ka): a given (threadId,vendorId) always
  // resolves the same gender. The thanks index follows the particle index so
  // "krub" pairs with "Khop khun krub!" and "ka" with "Khop khun ka!".
  let particle: string | undefined;
  let regionalThanks: string | undefined;
  if (flavor) {
    const genderRng = mulberry32(fnv1a32(`${seed.threadId}|${seed.vendorId}|particle`));
    const idx = flavor.particles.length ? Math.floor(genderRng() * flavor.particles.length) % flavor.particles.length : 0;
    // Particle appears sparingly (~1/3) and only when the region actually has one.
    particle = flavor.particles.length && rng() < 0.33 ? flavor.particles[idx] : undefined;
    // Regional thanks (terminal) appears sparingly too; gender-matched to the particle.
    if (flavor.thanks.length && rng() < 0.33) {
      regionalThanks = flavor.thanks[Math.min(idx, flavor.thanks.length - 1)];
    }
  }

  return {
    greeting: seededPick(rng, GREETINGS),
    selfIntro: seededPick(rng, SELF_INTROS),
    vehiclePhrase: seededPick(rng, VEHICLE_PHRASINGS),
    durationPhrase: seededPick(rng, DURATION_PHRASINGS),
    ask: seededPick(rng, ASK_PHRASINGS),
    extrasPhrase: seededPick(rng, EXTRAS_PHRASINGS),
    signOff: seededPick(rng, SIGN_OFFS),
    // Emoji weight: ~2/3 of messages carry one (a real texting distribution).
    emoji: rng() < 0.66 ? seededPick(rng, EMOJIS.filter(Boolean)) : "",
    order: seededPick(rng, SENTENCE_ORDERS),
    contraction: seededPick(rng, CONTRACTION_STYLES),
    particle,
    regionalThanks,
  };
}
