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

  const rival = cheapestCheaperRival(input.rivals, input.quotePerDay);
  if (rival && typeof input.quotePerDay === "number") {
    const gap = (input.quotePerDay - rival.pricePerDay) / input.quotePerDay;
    cards.push({
      kind: "rival",
      // Always above every other card: a competing live quote for the same
      // vehicle is the only lever backed by someone else's money.
      strength: 100 + Math.round(gap * 100),
      // PRICE AND VEHICLE, NEVER THE SHOP. The rail enforces it; this is what
      // the model is given so it has nothing to leak in the first place.
      line: `You have a better live offer on the same ${input.vehicleLabel}: ${rival.pricePerDay} ${
        rival.currency ?? cur
      }/day. Say you have a better offer at that price for this vehicle and ask them to match or beat it. NEVER name or hint at which shop it is - the shop's identity is not yours to give away.`,
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
