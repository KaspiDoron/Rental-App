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

/**
 * A vehicle phrase is a VERB PHRASE, and it needs a subject to stand alone.
 *
 * Every entry here is a predicate - "after a scooter", "need a scooter" - and
 * the compiler used to drop one straight after a question mark whenever the
 * self-intro slot came up empty. That is the literal production defect the
 * owner photographed: "Can I ask your daily price? after an automatic scooter
 * (125cc) for 3 days straight." A fragment, from a stranger, as a first
 * message.
 *
 * So each phrasing now carries the subject that makes it a sentence. "I'm
 * after a scooter" and "I need a scooter" take different ones, which is
 * exactly why a single hard-coded prefix could not have fixed it.
 */
export const VEHICLE_PHRASINGS = [
  { subject: "I'm", phrase: (v: string) => `looking to rent ${article(v)} ${v}` },
  { subject: "I", phrase: (v: string) => `need ${article(v)} ${v}` },
  { subject: "I'm", phrase: (v: string) => `hoping to get ${article(v)} ${v}` },
  { subject: "I'm", phrase: (v: string) => `after ${article(v)} ${v}` },
  { subject: "I", phrase: (v: string) => `want to rent ${article(v)} ${v}` },
  { subject: "I'm", phrase: (v: string) => `looking for ${article(v)} ${v} to rent` },
] as const;

// "for 1 days" shipped to every one-day rental. A shop reading that knows it
// came from a template, which is the one impression a cold first contact cannot
// afford. `day(d)` is the only place the plural is decided.
const day = (d: number) => (d === 1 ? "day" : "days");

export const DURATION_PHRASINGS = [
  (d: number) => `for ${d} ${day(d)}`,
  (d: number) => (d === 1 ? "for a single day" : `for about ${d} days`),
  (d: number) => `${d} ${day(d)} total`,
  (d: number) => (d === 1 ? "for one day" : `for the next ${d} days`),
  (d: number) => (d === 1 ? "for the one day" : `for ${d} days straight`),
] as const;

/**
 * WHEN THE RENTAL STARTS - the field that made the whole message answerable.
 *
 * `compileOpener` never referenced `rfq.startDate`. The opener asked a price
 * and gave no dates, so a shop owner literally could not quote it: availability
 * without a date is not a question, it is a rate-card request, which is exactly
 * what a reseller sends. The honest reading from the other end was "spam", and
 * on the enforcement axis that meters UNANSWERED new chats, a message nobody
 * can answer is the most expensive kind to send.
 *
 * Format is "12 Aug", never numeric: 8/12 reads as 12 August in most of the
 * target region and 8 December in the rest, and a wrong date is worse than no
 * date.
 */
export const DATE_PHRASINGS = [
  (from: string) => `from ${from}`,
  (from: string) => `starting ${from}`,
  (from: string) => `picking up ${from}`,
  (from: string) => `from around ${from}`,
] as const;

export const DATE_RANGE_PHRASINGS = [
  (from: string, to: string) => `${from} to ${to}`,
  (from: string, to: string) => `from ${from} until ${to}`,
  (from: string, to: string) => `${from} - ${to}`,
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

/**
 * A ONE-WAY DROP-OFF CHANGES THE PRICE, AND WE WERE NEVER MENTIONING IT.
 *
 * `rfq.oneWayDropOff` survives the profiler and then reappears only at booking
 * time (BookingSheet / bookings route). compileOpener REPLACES whatever the
 * client built, so nothing between those two points ever told the shop - the
 * whole negotiation priced a round-trip rental, that number was presented as
 * the deal, and the one-way fee surfaced at handover. Unlike delivery there is
 * no probe move anywhere that can recover it later.
 */
export const DROPOFF_PHRASINGS = [
  (x: string) => `I'd need to drop it off in ${x} (one-way).`,
  (x: string) => `It would be a one-way - returning it in ${x}.`,
  (x: string) => `I'd be leaving it in ${x} rather than bringing it back, if that works.`,
] as const;

/**
 * A delivery REQUEST, with no address in it. The address is gated by the
 * disclosure rail (resolveShareableLocation) and is never ours to send
 * unprompted; asking whether delivery is possible at all costs nothing and is
 * the thing the traveller actually asked for. The engine's `fulfillment-probe`
 * can recover this later, which is why it is the softer of the two.
 */
export const DELIVERY_PHRASINGS = [
  () => `Would you be able to deliver it to where I'm staying?`,
  () => `Do you deliver, or would I collect from the shop?`,
  () => `Is delivery an option, or is it pickup only?`,
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

/**
 * SHORT SENTENCES, PLAIN WORDS - the register a shop that reads English as a
 * second language actually parses.
 *
 * The pools above are written for a native reader: "What's the best you can do
 * per day?" is idiomatic and, to a counter in Ko Tao reading on a phone, it is
 * a puzzle. REGION_FLAVOR supplied particles and a thank-you and nothing else,
 * so every non-English-speaking region got the same idioms as everyone else.
 *
 * This is not baby talk and it is not a costume: it is the same request, in
 * words with fewer meanings. Per the owner's decision the tone stays casual
 * and the local particle stays.
 */
export const PLAIN_ASKS = [
  "How much per day?",
  "What is your best price per day?",
  "Can you tell me the price per day?",
  "Best price per day?",
] as const;

export const PLAIN_GREETINGS = ["Hi!", "Hello!", "Hi there!"] as const;
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

/**
 * Sentence-order templates for the opener skeleton.
 *
 * There were three, and the matrix's ~40k combinations were all one of three
 * SHAPES - which is what a fingerprint actually keys on, far more than word
 * choice. Two more, both real texting patterns: the ask sandwiched between
 * greeting and detail, and a bare two-sentence opener with no greeting at all.
 */
export const SENTENCE_ORDERS = [
  "greet-intro-ask",
  "greet-ask-intro",
  "intro-first",
  "greet-detail-ask",
  "intro-ask-plain",
] as const;
export type SentenceOrder = (typeof SENTENCE_ORDERS)[number];

export interface StyleChoice {
  greeting: string;
  selfIntro: string;
  vehiclePhrase: (v: string) => string;
  /** The subject that turns `vehiclePhrase` into a standalone sentence. */
  vehicleSubject: string;
  durationPhrase: (d: number) => string;
  /** "from 12 Aug" - the field that makes the opener answerable at all. */
  datePhrase: (from: string) => string;
  /** "12 Aug to 19 Aug" - used when the return date is known too. */
  dateRangePhrase: (from: string, to: string) => string;
  ask: string;
  /** How the traveller's extras are asked for, when there are any. */
  extrasPhrase: (x: string) => string;
  /** How a one-way return is stated, when the traveller asked for one. */
  dropOffPhrase: (x: string) => string;
  /** How delivery is asked about. Carries NO address - see DELIVERY_PHRASINGS. */
  deliveryPhrase: () => string;
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
    // The owner's call: casual English WITH the local particle. ~1/3 was sparse
    // enough that most messages to a Thai shop carried no krub/ka at all, which
    // is the one cheap signal that a stranger has bothered to be polite here.
    particle = flavor.particles.length && rng() < 0.6 ? flavor.particles[idx] : undefined;
    // Regional thanks (terminal) appears sparingly too; gender-matched to the particle.
    if (flavor.thanks.length && rng() < 0.33) {
      regionalThanks = flavor.thanks[Math.min(idx, flavor.thanks.length - 1)];
    }
  }

  // DRAW ORDER IS THE SEED'S CONTRACT. Every pick consumes the PRNG, so the
  // order these are taken in decides what a given (thread, vendor, nonce)
  // compiles to. Hoisting the vehicle pick above the greeting would silently
  // re-shuffle every opener in the app; it is drawn in place instead.
  // A region entry in REGION_FLAVOR IS the signal: those are the markets whose
  // shops read English as a second language, which is the same set that gets
  // particles and a local thank-you. One fact, not two lists to keep in sync.
  const plain = Boolean(flavor);
  const greeting = seededPick(rng, plain ? PLAIN_GREETINGS : GREETINGS);
  const selfIntro = seededPick(rng, SELF_INTROS);
  const vehicle = seededPick(rng, VEHICLE_PHRASINGS);
  return {
    greeting,
    selfIntro,
    vehiclePhrase: vehicle.phrase,
    vehicleSubject: vehicle.subject,
    durationPhrase: seededPick(rng, DURATION_PHRASINGS),
    datePhrase: seededPick(rng, DATE_PHRASINGS),
    dateRangePhrase: seededPick(rng, DATE_RANGE_PHRASINGS),
    ask: seededPick(rng, plain ? PLAIN_ASKS : ASK_PHRASINGS),
    extrasPhrase: seededPick(rng, EXTRAS_PHRASINGS),
    dropOffPhrase: seededPick(rng, DROPOFF_PHRASINGS),
    deliveryPhrase: seededPick(rng, DELIVERY_PHRASINGS),
    signOff: seededPick(rng, SIGN_OFFS),
    // Emoji weight: ~2/3 of messages carry one (a real texting distribution).
    emoji: rng() < 0.66 ? seededPick(rng, EMOJIS.filter(Boolean)) : "",
    order: seededPick(rng, SENTENCE_ORDERS),
    contraction: seededPick(rng, CONTRACTION_STYLES),
    particle,
    regionalThanks,
  };
}
