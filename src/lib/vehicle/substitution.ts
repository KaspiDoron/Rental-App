// A SHOP THAT OFFERS SOMETHING ELSE IS NOT A SHOP THAT SAID NO.
//
// The identity gate is good at deciding that the vehicle on the table is not
// the one the traveller asked for. What happened next was always the same:
// `wrongVehicle` made `redirect-close` the only legal move, the agent thanked
// the shop, and the thread ended. That is correct for "we only rent cars" and
// completely wrong for "no 125 today, but I have a 150 for 220" - which is the
// same ride, twenty baht more, from a shop that is trying to do business.
//
// A traveller would look at that and decide in one second. The app closed the
// conversation instead, and then reported the search as having fewer options.
//
// This module holds the DECISION, not the detection. Detection is a semantic
// read (AlternativeVehicleOffer); what to do about it is policy, and policy is
// deterministic so it can be reviewed on one screen.

export type Closeness = "equivalent" | "acceptable" | "different-class" | "unclear";

export interface AlternativeOffer {
  /** What the shop named, in their words. */
  vehicle: string;
  engineSizeCc?: number | null;
  pricePerDay?: number | null;
  currency?: string | null;
  closeness: Closeness;
  /** One sentence the traveller reads to decide. */
  reason?: string | null;
  /** When it landed - a stale offer must not gate a thread forever. */
  at: number;
}

/**
 * How long a pending choice may hold a thread.
 *
 * A shop that offered a 150 two days ago has almost certainly rented it. Past
 * this the thread resumes on its own rather than sitting silent forever waiting
 * for a tap that is never coming - the F6 lesson, applied to a new state.
 */
export const CHOICE_TTL_MS = 6 * 60 * 60 * 1000;

export type SubstitutionAction =
  /** Ask the traveller. The thread PAUSES - we do not haggle someone else's bike. */
  | { kind: "offer-choice"; offer: AlternativeOffer }
  /** Genuinely a different category, or nothing was offered: close as before. */
  | { kind: "close" }
  /** Not a mismatch at all - carry on. */
  | { kind: "continue" };

export interface SubstitutionInput {
  /** The identity gate's verdict for the price on the table. */
  wrongVehicle: boolean;
  /** The semantic read of this message, when one ran. */
  alternative?: {
    offered: boolean;
    vehicle?: string | null;
    engineSizeCc?: number | null;
    pricePerDay?: number | null;
    closeness: Closeness;
    reason?: string | null;
    confidence?: number;
  } | null;
  currency?: string | null;
  now: number;
  /** A choice already waiting on this thread - never stack a second one. */
  pending?: AlternativeOffer | null;
}

/** Below this the model is guessing about the whole substitution. */
export const MIN_CONFIDENCE = 0.5;

/**
 * Decide what a wrong-vehicle turn should do.
 *
 * The bar for interrupting the traveller is deliberately high: only an
 * `equivalent` or `acceptable` substitute earns a question. A different class
 * closes exactly as it did before, because asking "do you want a car instead of
 * a scooter?" for every shop that only rents cars would be the noise that makes
 * people stop reading the app.
 */
export function decideSubstitution(input: SubstitutionInput): SubstitutionAction {
  if (!input.wrongVehicle) return { kind: "continue" };

  // A choice is already on the table. Do not ask twice, and do not close a
  // thread the traveller is still deciding about - until it goes stale.
  if (input.pending) {
    if (input.now - input.pending.at < CHOICE_TTL_MS) {
      return { kind: "offer-choice", offer: input.pending };
    }
    return { kind: "close" };
  }

  const alt = input.alternative;
  if (!alt || !alt.offered || !alt.vehicle) return { kind: "close" };
  if (typeof alt.confidence === "number" && alt.confidence < MIN_CONFIDENCE) return { kind: "close" };
  if (alt.closeness !== "equivalent" && alt.closeness !== "acceptable") return { kind: "close" };

  return {
    kind: "offer-choice",
    offer: {
      vehicle: alt.vehicle,
      engineSizeCc: alt.engineSizeCc ?? null,
      pricePerDay: alt.pricePerDay ?? null,
      currency: input.currency ?? null,
      closeness: alt.closeness,
      reason: alt.reason ?? null,
      at: input.now,
    },
  };
}

/**
 * The RFQ the thread negotiates against once the traveller accepts.
 *
 * Only the vehicle target moves. Duration, accessories, dates and the rest of
 * the request are untouched - the traveller agreed to a different bike, not to
 * a different rental. This is also why acceptance rewrites the target rather
 * than relaxing the identity gate: the gate keeps working, against the new
 * vehicle, so a THIRD substitution is caught the same way.
 */
export function retargetForAlternative<T extends { engineSizeCc?: number; notes?: string }>(
  rfq: T,
  offer: AlternativeOffer
): T {
  const note = `Traveller accepted the shop's alternative: ${offer.vehicle}`;
  return {
    ...rfq,
    ...(typeof offer.engineSizeCc === "number" && offer.engineSizeCc > 0
      ? { engineSizeCc: offer.engineSizeCc }
      : {}),
    notes: rfq.notes ? `${rfq.notes}. ${note}` : note,
  };
}
