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
  "Hello po!", // respectful PH particle - warm, common from travellers too
] as const;

export const SELF_INTROS = [
  "I'm visiting for a few days and",
  "I'm in town and",
  "I just got here and",
  "I'm staying nearby and",
  "Me and my partner are around and",
  "", // no intro - straight to the point (a real texting style)
] as const;

export const VEHICLE_PHRASINGS = [
  (v: string) => `looking to rent a ${v}`,
  (v: string) => `need a ${v}`,
  (v: string) => `hoping to get a ${v}`,
  (v: string) => `after a ${v}`,
  (v: string) => `want to rent a ${v}`,
  (v: string) => `looking for a ${v} to rent`,
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

export const SIGN_OFFS = [
  "Thanks!",
  "Thank you!",
  "Thanks a lot!",
  "Salamat!", // PH
  "Cheers!",
  "", // no sign-off
] as const;

/** Light, respectful region flavor - at most ONE word, never a costume. */
export const REGION_SLANG: Record<string, readonly string[]> = {
  philippines: ["po", "salamat"],
  thailand: ["krub", "ka"],
  indonesia: ["terima kasih"],
  vietnam: ["cam on"],
};

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
  signOff: string;
  emoji: string;
  order: SentenceOrder;
  contraction: ContractionStyle;
  slang: string | undefined;
}

/** Draw one full style combination from the matrix - pure + deterministic. */
export function drawStyle(seed: CopySeed, region?: string): StyleChoice {
  const rng = seedRng(seed);
  const regionKey = (region ?? "").toLowerCase();
  const slangPool = Object.entries(REGION_SLANG).find(([k]) => regionKey.includes(k))?.[1];
  return {
    greeting: seededPick(rng, GREETINGS),
    selfIntro: seededPick(rng, SELF_INTROS),
    vehiclePhrase: seededPick(rng, VEHICLE_PHRASINGS),
    durationPhrase: seededPick(rng, DURATION_PHRASINGS),
    ask: seededPick(rng, ASK_PHRASINGS),
    signOff: seededPick(rng, SIGN_OFFS),
    // Emoji weight: ~2/3 of messages carry one (a real texting distribution).
    emoji: rng() < 0.66 ? seededPick(rng, EMOJIS.filter(Boolean)) : "",
    order: seededPick(rng, SENTENCE_ORDERS),
    contraction: seededPick(rng, CONTRACTION_STYLES),
    // Slang appears sparingly (~1/3) and only when the region has a pool.
    slang: slangPool && rng() < 0.33 ? seededPick(rng, slangPool) : undefined,
  };
}
