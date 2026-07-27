// ONE PROFILE PER VEHICLE CLASS - so every stage of the funnel is parameterised
// instead of quietly assuming a two-wheeler.
//
// Car search was not "a bit rough", it was systemically blocked, and every
// symptom came from the same shape: the pipeline knew one vehicle well and
// treated the others as that one with a different word attached.
//
//   - the RFQ builder defaulted `seats: 4` on every car search. `seats` is a
//     DISQUALIFYING attribute in the identity gate, so every car search silently
//     demanded a seat count the traveller never gave - and a shop quoting a car
//     whose seat count it did not state could not be confirmed. The quote never
//     reached the board.
//   - discovery stamped `vehicleClasses: [searchedClass]` on every place it
//     found, so "this shop rents cars" was a restatement of what we asked for,
//     never a fact about the shop. A "definitely rents cars" filter built on
//     that would be decoration.
//   - the negotiation coach's examples were scooters ("150/day for a 125cc
//     here", "I have offer 170 for same bike") on every turn, in every class.
//   - the price floors for all five car buckets were the local SCOOTER floor
//     multiplied by a constant, which is not a car price in any market.
//
// A profile is data. Adding a class - a van, a bicycle, a jetski - is a row
// here, not a branch in five call sites.

import type { AttributeKey } from "./spec";

export type VehicleClassKind = "scooter" | "motorbike" | "car";

export interface ClassProfile {
  kind: VehicleClassKind;
  /** How a traveller says it in a sentence. */
  noun: string;
  /**
   * Attributes that are MEANINGFUL for this class. Only these may ever be
   * declared, and only a DECLARED one can disqualify a quote - an attribute the
   * traveller never gave is not a requirement.
   */
  attributes: AttributeKey[];
  /** The attribute that usually decides "is this the right one?" for the class. */
  decisive: AttributeKey;
  /** Words that mean a shop deals in this class at all - discovery + evidence. */
  vocabulary: string[];
  /** What a real example looks like, for prompts and coaching. */
  exemplar: { vehicle: string; leverage: string };
}

export const CLASS_PROFILES: Record<VehicleClassKind, ClassProfile> = {
  scooter: {
    kind: "scooter",
    noun: "scooter",
    attributes: ["class", "displacementCc", "transmission"],
    decisive: "displacementCc",
    vocabulary: ["scooter", "moped", "matic", "automatic", "125", "150", "honda click", "nmax"],
    exemplar: {
      vehicle: "automatic 125cc scooter",
      leverage: "I have an offer at 170 for the same scooter, can you do better?",
    },
  },
  motorbike: {
    kind: "motorbike",
    noun: "motorbike",
    attributes: ["class", "displacementCc", "transmission"],
    decisive: "displacementCc",
    vocabulary: ["motorbike", "motorcycle", "manual", "geared", "dirt bike", "enduro", "crf", "klx"],
    exemplar: {
      vehicle: "150cc manual motorbike",
      leverage: "another shop quoted 400 for the same bike - can you match it?",
    },
  },
  car: {
    kind: "car",
    noun: "car",
    // NO seat count unless the traveller gave one. This is the whole fix for
    // the blocked car funnel: `seats` stays a legitimate disqualifier when it is
    // DECLARED, and is simply absent when it is not.
    attributes: ["class", "seats", "transmission", "fuel"],
    decisive: "seats",
    vocabulary: [
      "car",
      "cars",
      "sedan",
      "suv",
      "hatchback",
      "mpv",
      "van",
      "minivan",
      "4 wheels",
      "four wheels",
      "self drive",
      "self-drive",
      "avanza",
      "vios",
      "innova",
      "xpander",
      "yaris",
      "city",
      "almera",
      "fortuner",
      "ertiga",
    ],
    exemplar: {
      vehicle: "automatic car",
      leverage: "another shop quoted 900 for the same car - can you do better?",
    },
  },
};

export function profileFor(vehicleClass: string | undefined): ClassProfile {
  const k = String(vehicleClass ?? "").toLowerCase();
  if (k === "car") return CLASS_PROFILES.car;
  if (k === "motorbike") return CLASS_PROFILES.motorbike;
  return CLASS_PROFILES.scooter;
}

/**
 * Does this text show EVIDENCE that a shop deals in this class? Used for the
 * "definitely rents cars" chip, which has to be a fact about the shop rather
 * than a restatement of what we searched for.
 *
 * Word boundaries matter: "car" inside "Carlos" or "scarcity" is not evidence.
 */
export function mentionsClass(text: string, profile: ClassProfile): boolean {
  const s = String(text ?? "").toLowerCase();
  return profile.vocabulary.some((w) => {
    const rx = new RegExp(`(?:^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z0-9]|$)`);
    return rx.test(s);
  });
}

/**
 * How each vehicle bucket prices relative to the local 125cc scooter floor.
 * Two-wheelers scale from a scooter sensibly - they are the same kind of thing.
 * CARS DO NOT: a car is a different market with different fixed costs, and
 * multiplying a scooter floor by a constant produced numbers that were not car
 * prices anywhere. Cars anchor on their own USD-based baseline instead
 * (src/lib/market defaultFloor), and this table only covers what it can.
 */
export const SCOOTER_RELATIVE: Record<string, number> = {
  "scooter-110": 0.8,
  "scooter-125": 1,
  "scooter-160": 1.4,
  "motorbike-150": 1.2,
  "motorbike-300": 2.4,
  "motorbike-500": 4,
  "motorbike-big": 6,
};

/** Is this vehicle bucket one the scooter floor can legitimately scale to? */
export function scalesFromScooter(vehicleKey: string): boolean {
  return vehicleKey in SCOOTER_RELATIVE;
}
