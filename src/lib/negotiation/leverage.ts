// THE LEVERAGE PLAN: which card to play, ranked by the evidence behind it.
//
// The failure this exists for, and the owner called it the major one: the
// strongest card in a negotiation - another real shop, in this same search, that
// quoted less for the same vehicle - was played LAST or not at all, because the
// round directive hard-coded "use the N-day rental as your reason" on the first
// push and only reached the rival on a later one. Many threads never got a later
// one. Duration is the weakest lever we have; a live competing quote is the
// strongest. The order was backwards, and it was backwards by construction: the
// engine had no representation of leverage at all, just a chain of prompt
// paragraphs in a fixed sequence.
//
// A leverage CARD makes the ordering a computation over evidence instead of a
// sentence order in a template. The engine hands the model a ranked plan; the
// model still chooses the words, and still chooses among legal moves. That is
// the repo's boundary - code computes what is available and how strong it is,
// the LLM decides how to say it.
//
// DISCLOSURE IS PART OF THE CARD. The rival card carries the price and the
// vehicle and NEVER the rival shop's name (see redactRivalIdentity in
// spte/rails). The prompt used to interpolate `${cheaperRival.shop}` and order
// the model to name it, which meant the cheaper shop's NAME was sent to its
// competitor, from the traveller's own number. That is the traveller's leverage
// being spent on a shop that did not earn it, and it is not ours to give away.

import { beatRivalTarget } from "./beat-rival";

export type LeverageKind = "rival" | "duration" | "bundle" | "readiness";

export interface LeverageCard {
  kind: LeverageKind;
  /** Higher plays first. Computed from evidence, never from a hard-coded order. */
  strength: number;
  /** What the model is told it may use. Never contains a rival's identity. */
  line: string;
}

export interface LeverageInput {
  /** Other shops' live quotes this search, same currency, same vehicle. */
  rivals: Array<{ pricePerDay: number; currency?: string; shop?: string }>;
  /** This shop's live quote. */
  quotePerDay?: number;
  currency?: string;
  durationDays: number;
  /** How many times we have already pushed on price in this thread. */
  round: number;
  /** How the traveller's vehicle reads in a sentence ("automatic 125cc scooter"). */
  vehicleLabel: string;
  /** The grounded market floor, so the rival card can name a target that is
   *  strictly below the rival without dropping into insulting-lowball range. */
  floorPerDay?: number | null;
  /**
   * The rival's per-day figure was DERIVED from a longer package (their 3-day
   * total divided out), not quoted for this rental length. The card then has to
   * SAY so - "their 3-day price works out to about 167/day" - because
   * presenting it as a quote for these days is a number no shop ever said.
   */
  rivalDerivedFromDays?: number | null;
  /**
   * May the card name a concrete counter-price?
   *
   * Defaults to true - a number is an anchor and "beat it" with no number is an
   * ask the shop answers with the rival's own price. It is false for exactly
   * one caller: the open-ended arm of the owner's phrasing A/B
   * (negotiation/ask-variant), which exists to measure what happens when we
   * state their price and let THEM pick the figure. Without this the card and
   * the arm directive contradicted each other in the same prompt, and a
   * contradiction is not an experiment.
   *
   * BEAT NEVER MATCH HOLDS EITHER WAY: with no number named, the card still
   * demands a price strictly below the rival.
   */
  nameATarget?: boolean;
  /**
   * THIS shop is already the cheapest quote in the session.
   *
   * There is then nothing to leverage - we would be arguing against a floor we
   * set ourselves. In the field the planner fell through to its weakest card
   * (duration, strength 40) and told the cheapest shop on the island that
   * 180/day was "a bit high", four minutes after another shop had quoted 250.
   */
  isSessionLow?: boolean;
}

/** A rival only counts when it is genuinely CHEAPER than what is on the table. */
export function cheapestCheaperRival(
  rivals: LeverageInput["rivals"],
  quotePerDay?: number
): { pricePerDay: number; currency?: string } | null {
  if (typeof quotePerDay !== "number") return null;
  let best: { pricePerDay: number; currency?: string } | null = null;
  for (const r of rivals) {
    if (typeof r.pricePerDay !== "number" || r.pricePerDay >= quotePerDay) continue;
    if (!best || r.pricePerDay < best.pricePerDay) {
      best = { pricePerDay: r.pricePerDay, currency: r.currency };
    }
  }
  return best;
}

/**
 * The ranked plan for this turn. Strength is evidence:
 *   - a live cheaper rival is the strongest card there is, and the bigger the
 *     gap the stronger it gets;
 *   - duration only counts on a genuinely multi-day rental, and it weakens once
 *     it has been played;
 *   - a bundle ask and "ready to book now" are later-round cards.
 */
export function planLeverage(input: LeverageInput): LeverageCard[] {
  const cards: LeverageCard[] = [];
  const cur = input.currency ?? "";

  // THE CHEAPEST SHOP IN THE SESSION IS NOT A SHOP TO ARGUE WITH.
  //
  // This function returns whatever it has, and the caller leads with the
  // strongest card it gets - so with no rival cheaper and no round played, the
  // list still came back holding "3 days is a long rental" and the agent
  // pushed. Being the floor is not a weak position to argue from; it is a
  // position with no argument in it. Returning nothing lets the caller do the
  // right thing (terms, not price) instead of the least-wrong thing.
  //
  // The bundle card survives on purpose: asking for a helmet or free delivery
  // at the best price in the session is not bargaining against ourselves, it
  // is the one ask left that can still improve the deal.
  if (input.isSessionLow) {
    if (input.round >= 1) {
      cards.push({
        kind: "bundle",
        strength: 30,
        line: `They are already the best price you have. Do not push the number again - ask for something thrown in instead: a helmet, fuel, or free delivery.`,
      });
    }
    return cards;
  }

  const rival = cheapestCheaperRival(input.rivals, input.quotePerDay);
  if (rival && typeof input.quotePerDay === "number") {
    const gap = (input.quotePerDay - rival.pricePerDay) / input.quotePerDay;
    // BEAT, NEVER MATCH. This line used to end "ask them to match or beat it",
    // and it is the card that reaches the LIVE engine through spte/pass - so
    // fixing composeBargain alone left the running agent asking shops to match.
    // A match is the traveller's strongest card spent for the price they
    // already had; the ask is a concrete number strictly BELOW the rival.
    const target = beatRivalTarget({
      rivalPricePerDay: rival.pricePerDay,
      quotePerDay: input.quotePerDay,
      floorPerDay: input.floorPerDay,
    });
    const rivalCur = rival.currency ?? cur;
    // HONEST PROVENANCE. A per-day figure we DERIVED from their multi-day
    // package was never quoted by anyone for this rental length, so it is
    // phrased as the arithmetic it is instead of as a quote (owner report 5
    // #2 - the Thai draft that cited "167 baht/day", a number no shop said).
    const derivedDays = input.rivalDerivedFromDays;
    const offerPhrase =
      typeof derivedDays === "number" && derivedDays > 0
        ? `another shop's ${derivedDays}-day price works out to about ${rival.pricePerDay} ${rivalCur}/day - say it EXACTLY that way ("works out to about"), never as a per-day price they quoted you`
        : `you have a better live offer on the same ${input.vehicleLabel} at ${rival.pricePerDay} ${rivalCur}/day`;
    cards.push({
      kind: "rival",
      // Always above every other card: a competing live quote for the same
      // vehicle is the only lever backed by someone else's money.
      strength: 100 + Math.round(gap * 100),
      // PRICE AND VEHICLE, NEVER THE SHOP. The rail enforces it; this is what
      // the model is given so it has nothing to leak in the first place.
      line:
        `${offerPhrase}. Say you have a better offer at that price, then ` +
        (input.nameATarget === false
          ? `ask THIS shop to go BELOW that number - let them name the figure, do NOT propose one yourself. `
          : `ask THIS shop for ${target} ${rivalCur}/day - a number strictly BELOW the other offer. `) +
        `NEVER ask them to "match", to do "the same", or to "get close to" it: ` +
        `matching leaves the traveller exactly where they already are, so the only acceptable outcome is a LOWER price. ` +
        `NEVER name or hint at which shop it is - the shop's identity is not yours to give away.`,
    });
  }

  if (input.durationDays >= 3) {
    cards.push({
      kind: "duration",
      // Real, but weak - and weaker still once it has been used.
      strength: input.round <= 0 ? 40 : 15,
      line: `${input.durationDays} days is a long rental - worth a better daily rate.`,
    });
  }

  if (input.round >= 1) {
    cards.push({
      kind: "bundle",
      strength: 30,
      line: `Ask for something thrown in instead of a lower number - a helmet, fuel, or free delivery.`,
    });
    cards.push({
      kind: "readiness",
      strength: 25,
      line: `You are ready to book right now - that is worth something to them today.`,
    });
  }

  return cards.sort((a, b) => b.strength - a.strength);
}

/** The card to lead with, or null when we have none. */
export function leadCard(cards: LeverageCard[]): LeverageCard | null {
  return cards[0] ?? null;
}

/**
 * Every name/alias a rival shop is known by, for the disclosure rail. Short and
 * generic words are dropped: rejecting a draft because it contains "rental" or
 * "the" would reject every draft.
 */
export function rivalIdentityTokens(shops: Array<string | undefined>): string[] {
  const GENERIC = new Set([
    "rental",
    "rentals",
    "rent",
    "shop",
    "shops",
    "moto",
    "motor",
    "motorbike",
    "scooter",
    "bike",
    "bikes",
    "car",
    "cars",
    "hire",
    "service",
    "services",
    "center",
    "centre",
    "travel",
    "tour",
    "tours",
    "the",
    "and",
  ]);
  const out = new Set<string>();
  for (const shop of shops) {
    const cleaned = String(shop ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .trim();
    if (!cleaned) continue;
    // The full name, and each distinctive word in it.
    if (cleaned.length >= 4) out.add(cleaned);
    for (const w of cleaned.split(/\s+/)) {
      if (w.length >= 4 && !GENERIC.has(w)) out.add(w);
    }
  }
  return [...out];
}

/** Does this draft name a rival shop? Word-boundary matched, so a name that
 *  merely appears inside a longer word is not a false positive. */
export function namesRival(text: string, tokens: string[]): string | null {
  const s = String(text ?? "").toLowerCase();
  for (const token of tokens) {
    const rx = new RegExp(`(?:^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z0-9]|$)`);
    if (rx.test(s)) return token;
  }
  return null;
}
