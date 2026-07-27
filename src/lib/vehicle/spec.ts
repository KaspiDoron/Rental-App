// WHAT MAKES A VEHICLE *THE* VEHICLE - as a general attribute model.
//
// Two live failures, one day apart, both the same shape:
//
//   Joh's Matics  "for the Honda beat sir 400 pesos sir for the honda click
//                  125 500 pesos since you rent for 4 days"
//   Coyote Way    "Regular price sir is 700 per day, I already gave 500 for
//                  you. If you want 110cc 400 per day"
//
// Both times the app took 400 and put it on screen as the traveller's BEST
// PRICE. Both times 400 was a 110cc - the second shop typed "110cc" in the same
// sentence. The traveller had declared an automatic 125cc, and their licence
// declaration covers exactly that.
//
// The tempting fix is a rule about 110 and 125. That rule would be worthless a
// week later: the same failure is far worse in cars, where one nameplate spans
// engines, gearboxes, seat counts and fuel types, and no list of models could
// ever be complete.
//
// So the model here is not "which vehicles exist". It is:
//
//   * A vehicle is a set of ATTRIBUTES.
//   * Some attributes are DISQUALIFYING - get them wrong and the traveller is
//     on something their licence, insurance or seatbelts do not cover. The rest
//     are preferences.
//   * Every disqualifying attribute has exactly three states: RESOLVED-AND-
//     MATCHING, RESOLVED-AND-CONFLICTING, or UNRESOLVED.
//   * UNRESOLVED IS NOT A MATCH. It is a question the agent has to ask before
//     anything may be presented, bargained or booked.
//
// That is what generalises. A 110cc BeAT conflicts on displacement; a manual
// Wave conflicts on transmission; a 5-seat Vios when four adults need seats
// conflicts on seats; a "Toyota Avanza" whose gearbox nobody stated is simply
// unresolved, and the agent asks. One mechanism, every vehicle category.

export type VehicleClassKind = "scooter" | "motorbike" | "car";
export type TransmissionKind = "automatic" | "manual" | "semi-automatic";
export type FuelKind = "petrol" | "diesel" | "electric" | "hybrid";

/** Everything the system can know about a vehicle. Extend here, not in callers. */
export interface VehicleAttributes {
  class?: VehicleClassKind;
  /** Engine size. The decisive attribute for two-wheelers in most of the region. */
  displacementCc?: number;
  transmission?: TransmissionKind;
  /** Cars: how many people it legally seats. */
  seats?: number;
  fuel?: FuelKind;
}

export type AttributeKey = keyof VehicleAttributes;

/**
 * Where a value came from. Ordered weakest to strongest, because a value the
 * shop typed about THIS vehicle always beats general knowledge about the
 * nameplate - that is how a rare market variant survives the catalogue.
 */
export type Evidence = "unresolved" | "class-word" | "catalogue" | "stated";

export const EVIDENCE_RANK: Record<Evidence, number> = {
  unresolved: 0,
  "class-word": 1,
  catalogue: 2,
  stated: 3,
};

export interface AttributeDef {
  key: AttributeKey;
  /** How the traveller would say it. Used verbatim in questions and on cards. */
  label: string;
  /**
   * Getting this wrong puts the traveller on a vehicle they are not covered
   * for. Disqualifying attributes gate presentation, bargaining and booking;
   * everything else is a preference the traveller can weigh themselves.
   */
  disqualifying: boolean;
  /** Does what the shop has match what the traveller declared? */
  matches: (want: unknown, got: unknown) => boolean;
  /** How to phrase the gap when this attribute is the one still unresolved. */
  ask: (want: unknown) => string;
}

/**
 * Badge rounding, and nothing looser. Manufacturers sell a "125" as 124.8cc, so
 * a few cc of slack is honest - but a 110 and a 125 are different bikes on
 * different licences, and "close enough" is exactly the reasoning that shipped
 * a BeAT as a Click.
 */
export function sameDisplacement(want: number, got: number): boolean {
  return Math.abs(want - got) <= Math.max(5, want * 0.06);
}

export const ATTRIBUTES: Record<AttributeKey, AttributeDef> = {
  class: {
    key: "class",
    label: "vehicle type",
    disqualifying: true,
    matches: (want, got) => want === got,
    ask: (want) => `is it actually a ${String(want)}?`,
  },
  displacementCc: {
    key: "displacementCc",
    label: "engine size",
    disqualifying: true,
    matches: (want, got) =>
      typeof want === "number" && typeof got === "number" && sameDisplacement(want, got),
    ask: (want) => `is it a ${String(want)}cc?`,
  },
  transmission: {
    key: "transmission",
    label: "transmission",
    disqualifying: true,
    matches: (want, got) => want === got,
    ask: (want) =>
      want === "automatic" ? "is it a fully automatic one?" : `is it ${String(want)}?`,
  },
  seats: {
    key: "seats",
    // A car that seats fewer people than the party is not a cheaper option, it
    // is the wrong car - the same class of error as the wrong engine size.
    label: "seats",
    disqualifying: true,
    matches: (want, got) => typeof want === "number" && typeof got === "number" && got >= want,
    ask: (want) => `does it seat ${String(want)}?`,
  },
  fuel: {
    key: "fuel",
    label: "fuel",
    disqualifying: false,
    matches: (want, got) => want === got,
    ask: (want) => `is it ${String(want)}?`,
  },
};

/**
 * The attributes that must be settled before a price may be shown as a deal.
 *
 * Only the ones the traveller actually DECLARED count: a search that never
 * mentioned seats cannot be blocked on seats. This is what keeps the gate
 * strict without making it impossible to satisfy.
 */
export function disqualifyingKeys(declared: VehicleAttributes): AttributeKey[] {
  return (Object.keys(ATTRIBUTES) as AttributeKey[]).filter(
    (k) => ATTRIBUTES[k].disqualifying && declared[k] !== undefined
  );
}

/** A short human rendering of a spec: "automatic 125cc scooter", "5-seat car". */
export function describeSpec(a: VehicleAttributes): string {
  const bits: string[] = [];
  if (a.transmission) bits.push(a.transmission);
  if (a.displacementCc) bits.push(`${a.displacementCc}cc`);
  if (a.seats) bits.push(`${a.seats}-seat`);
  if (a.fuel) bits.push(a.fuel);
  bits.push(a.class ?? "vehicle");
  return bits.join(" ");
}
