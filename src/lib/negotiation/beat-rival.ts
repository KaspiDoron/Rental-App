// BEAT, NEVER MATCH - the one place that decides what we ask for when another
// shop has already quoted less, and the deterministic test that proves we asked
// for it.
//
// THE FAILURE. The owner read a live message that said "Could you match the 200
// THB/day offer". Matching is not bargaining: it hands the shop the traveller's
// strongest card and asks for nothing in return, and the best possible outcome
// of a successful match is the price the traveller already had. Every prompt in
// the repo said "match or beat it" - three independent builders (composeBargain's
// system rule, composeBargain's user message, and the ranked leverage card that
// reaches the live engine) plus a few-shot that literally modelled the match
// ("you can do same or better?"), plus a deterministic fallback pool that asked
// for the rival's EXACT number when no target had been computed.
//
// THE SHAPE OF THE FIX. Two halves, and both are needed:
//
//   1. Every prompt site asks for a CONCRETE number strictly below the rival.
//      "Beat it" with no number is an open-ended ask the shop answers with the
//      rival's price; a number is an anchor.
//   2. A post-rail refuses match-phrasing on the finished draft. Every other
//      "never match" control in this repo is prompt advice, and this codebase's
//      own comments are explicit that advice is not a guarantee. `citesAMatch`
//      is that guarantee (see spte/rails.ts).
//
// Both halves live here so the prompt and the rail can never drift apart: the
// number the prompt asks for and the phrasing the rail refuses are one module.

/** How far below the rival we aim by default - 5%, floor-clamped below. */
const BEAT_MARGIN = 0.95;

export interface BeatRivalInput {
  /** The competing live quote we are beating. */
  rivalPricePerDay: number;
  /** This shop's own quote, when it has one. */
  quotePerDay?: number | null;
  /** The grounded market floor - we never ask below it unless it is itself at
   *  or above the rival, in which case the rival binds. */
  floorPerDay?: number | null;
}

/**
 * The ask that BEATS a rival.
 *
 * Guarantees, in order of precedence:
 *   - the result is ALWAYS strictly below the rival (this is the doctrine);
 *   - it never drops below the market floor unless the floor itself is at or
 *     above the rival - a floor above the rival cannot be honoured while
 *     beating it, and the doctrine wins;
 *   - it never exceeds an aggressive read of this shop's own quote, so a shop
 *     quoting 210 against a 200 rival is asked for 190, not 199.
 *
 * Integer output: shops quote whole units, and a "189.5/day" ask reads as a
 * machine wrote it.
 */
export function beatRivalTarget(input: BeatRivalInput): number {
  const rival = Number(input.rivalPricePerDay);
  if (!Number.isFinite(rival) || rival <= 0) return 0;
  // The hard ceiling: one unit under the rival is the LEAST aggressive ask that
  // is still not a match. Everything below is clamped into this.
  const strictCeiling = Math.max(1, Math.ceil(rival) - 1);

  let ask = Math.round(rival * BEAT_MARGIN);
  const quote = Number(input.quotePerDay);
  if (Number.isFinite(quote) && quote > 0) {
    // A shop barely above the rival still gets a real cut asked of it.
    ask = Math.min(ask, Math.round(quote * 0.85));
  }
  const floor = Number(input.floorPerDay);
  if (Number.isFinite(floor) && floor > 0) {
    // Never insult the shop with a sub-floor lowball - but never let the floor
    // push the ask up to (or past) the rival either.
    ask = Math.max(ask, Math.min(Math.round(floor), strictCeiling));
  }
  return Math.max(1, Math.min(ask, strictCeiling));
}

// ---- The rail's side: what a MATCH looks like in a finished draft ----------
//
// Deliberately narrow and price-scoped. "the same bike", "same day", "same as
// we said" are ordinary English in a rental chat and must never be rejected;
// what is refused is an ask whose OUTCOME is the rival's own number.
const MATCH_PATTERNS: Array<{ rule: string; rx: RegExp }> = [
  // "can you match it / that / their price / the 200"
  { rule: "match", rx: /\bmatch(?:es|ed|ing)?\s+(?:it|that|this|them|their|the|a|any|those|these|\d)/i },
  // "match or beat" - the exact phrase every prompt used to carry. It PERMITS a
  // match, so it is refused even though it names beating as an alternative.
  { rule: "match-or-beat", rx: /\bmatch\s+(?:it\s+)?or\s+beat\b/i },
  // "same price / rate / number / amount / deal / offer"
  { rule: "same-price", rx: /\bsame\s+(?:price|rate|number|amount|deal|offer|cost|figure)\b/i },
  // "can you do the same?", "give me the same"
  { rule: "do-the-same", rx: /\b(?:do|give|make|offer|go)\s+(?:me\s+|us\s+)?(?:the\s+)?same\b/i },
  // "same or better" - the few-shot's own words.
  { rule: "same-or-better", rx: /\bsame\s+or\s+(?:better|less|lower|cheaper|more)\b/i },
  // "meet that price"
  { rule: "meet-price", rx: /\bmeet\s+(?:it|that|this|their|the)\s*(?:price|offer|rate|number)?\b/i },
  // "equal to that", "the same as their price"
  { rule: "equal-to", rx: /\bequal\s+(?:to\s+)?(?:it|that|this|their|the)\b/i },
  // "get close to 200", "close to that price" - a near-match is a match with
  // extra steps, and it was in the deterministic fallback pool verbatim.
  { rule: "close-to", rx: /\b(?:get\s+)?close\s+to\s+(?:that|this|it|their|the\s+\w+\s+)?\s*\d/i },
];

/**
 * Does this draft ask the shop to MATCH rather than beat?
 *
 * Returns the offending phrase (for the rejection detail) or null.
 */
export function citesAMatch(text: string): { rule: string; phrase: string } | null {
  const s = String(text ?? "");
  if (!s.trim()) return null;
  for (const { rule, rx } of MATCH_PATTERNS) {
    const m = rx.exec(s);
    if (m) return { rule, phrase: m[0].trim() };
  }
  return null;
}
