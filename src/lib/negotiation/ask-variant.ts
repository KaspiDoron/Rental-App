// THE A/B THE OWNER ASKED FOR, verbatim:
//
//   "I want to measure the times of successful bargain that we suggested a
//    lower price (we gave them a specific number) Vs the times of successful
//    bargaining that we didn't gave them a specific price and just asked for a
//    lower price than X (in both ways we write them the high price we already
//    have 'X')."
//
// Two arms, and the owner's parenthesis is the important half - BOTH arms state
// the number we are pushing down from. The variable under test is only whether
// we name our counter:
//
//   specific-number   "you have 250 - could you do 210 for the 3 days?"
//   open-ended-below  "you have 250 - could you do better than that for the 3 days?"
//
// WHY THIS MODULE EXISTS AT ALL. Every piece of the measurement was already in
// the repo except the label. `learnFromReply` is a precise one-turn-late
// concession detector - "did this shop come down, and by how much" - and it is
// live. What it credits is the MOVE NAME ("bargain"), which is identical in
// both arms, so the two phrasings were pooled into one indistinguishable
// statistic. One label is the whole gap.
//
// PER-THREAD, NOT PER-IDENTITY. `lib/cohort` gives stable hash bucketing keyed
// on a user, and using it here would put one traveller's ENTIRE hunt - all
// twelve shops - into a single arm. The unit of a bargaining phrasing is the
// negotiation, so the assignment key is the thread. A traveller then runs both
// arms in parallel against comparable shops in the same market on the same day,
// which is a far better-controlled comparison than splitting travellers.
//
// DETERMINISTIC, because the same thread must land in the same arm on every
// turn, on every instance, after every cold start - a thread that flipped arms
// mid-negotiation would contaminate both.

/** The two phrasings under test. Stored verbatim in telemetry. */
export type AskVariant = "specific-number" | "open-ended-below";

export const ASK_VARIANTS: readonly AskVariant[] = ["specific-number", "open-ended-below"] as const;

/**
 * FNV-1a plus an avalanche finalizer. Small, dependency-free and stable across
 * runtimes - this runs in the reply path, and `crypto.createHash` would pull
 * node:crypto into a module the pure-function tests import directly.
 *
 * THE FINALIZER IS NOT DECORATION. Bare FNV-1a has a weak low bit on
 * structured, near-identical keys - and every key here is structured and
 * near-identical by construction ("user@host:66812345678"). Taking `% 2` of the
 * raw hash over a thousand such keys put EVERY ONE of them in the same arm: a
 * "50/50 split" that was in fact 100/0, which would have produced an A/B with
 * an empty control and no way to notice from the numbers. The murmur3 mix below
 * spreads the entropy across all 32 bits before the bit that decides is read.
 */
function hash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Which arm this thread is in. Stable for the life of the thread.
 *
 * The key is the thread key (`user:vendor`), so two shops in the same hunt can
 * land in different arms and the same shop never changes arm between turns.
 */
/**
 * THE EXPERIMENT IS PAUSED FOR THE BETA - deliberately, and reversibly.
 *
 * The owner's stated launch requirement is a specific sentence: "we've received
 * an offer of 200 from another rental shop - can you offer 180?". The
 * `open-ended-below` arm instructs the composer to do the opposite ("do NOT
 * name a counter-price of your own... naming any specific number breaks this
 * instruction"), so a 50/50 split means half of all threads are contractually
 * forbidden from sending the thing the product is supposed to do.
 *
 * That is a fine trade when you are measuring which ask converts better. It is
 * a bad trade during a 50-user beta, where the sample is too small to settle
 * the question anyway and the cost is half the negotiations losing their
 * strongest move.
 *
 * The arm assignment, the directive text and `variantHonoured` all stay - flip
 * `ASK_VARIANT_SPLIT` back to true (or set the `ASK_VARIANT_SPLIT` config) once
 * there is enough traffic for the answer to mean something.
 */
export const ASK_VARIANT_SPLIT = false;

export function askVariantFor(threadKey: string): AskVariant {
  const key = String(threadKey ?? "").trim().toLowerCase();
  // An unkeyed turn is not an experiment subject. The specific-number arm is
  // the app's historical behaviour, so an unlabelled turn behaves as it always
  // did rather than silently sampling the new phrasing.
  if (!key) return "specific-number";
  if (!ASK_VARIANT_SPLIT) return "specific-number";
  return hash(key) % 2 === 0 ? "specific-number" : "open-ended-below";
}

/**
 * The prompt directive for an arm.
 *
 * Both arms are REQUIRED to state the shop's current price - that is the
 * owner's control, and without it the two arms differ in two variables instead
 * of one. What changes is only whether our counter is named.
 */
export function askVariantDirective(variant: AskVariant, args: { quotePerDay?: number; currency?: string; target?: number }): string {
  const cur = args.currency ? ` ${args.currency}` : "";
  const quote =
    typeof args.quotePerDay === "number" && args.quotePerDay > 0
      ? `You MUST name their current price (${args.quotePerDay}${cur}/day) in the message - that is what you are asking them to come down from. `
      : "";
  if (variant === "open-ended-below") {
    return (
      `${quote}ASK SHAPE (open-ended): do NOT name a counter-price of your own. ` +
      `Ask them to go BELOW their current number - "can you do better than that for me?" - and let THEM pick the figure. ` +
      `Naming any specific number of your own breaks this instruction.`
    );
  }
  const target =
    typeof args.target === "number" && args.target > 0 ? `${args.target}${cur}/day` : "the target you were given";
  return (
    `${quote}ASK SHAPE (specific number): name your counter explicitly - ask for ${target}. ` +
    `A concrete figure is the anchor; do not leave the number to them.`
  );
}

/**
 * Did the draft actually honour the arm it was assigned?
 *
 * The measurement is worthless if the open-ended arm quietly names a number
 * anyway - the two populations would then be the same population. This is a
 * cheap deterministic check the telemetry records alongside the arm, so a
 * contaminated sample is visible in the Ops card instead of silently averaged
 * into the result.
 *
 * `counterPricePerDay` is the pass's own structured field: the model states
 * what it asked for, so this needs no text parsing.
 */
export function variantHonoured(variant: AskVariant, counterPricePerDay?: number | null): boolean {
  const named = typeof counterPricePerDay === "number" && counterPricePerDay > 0;
  return variant === "specific-number" ? named : !named;
}
