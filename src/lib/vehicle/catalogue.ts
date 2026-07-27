// KNOWN NAMEPLATES - one EVIDENCE SOURCE for the attribute model in spec.ts.
//
// This is deliberately not "the rule". The rule lives in spec.ts (attributes,
// disqualifying vs preference, unresolved-is-not-a-match) and applies to any
// vehicle category. This file only answers one question: "the shop typed this
// name - what does that tell us about the attributes?"
//
// It is therefore allowed to be incomplete, and being incomplete is SAFE: a
// nameplate nobody has catalogued leaves its attributes UNRESOLVED, which the
// resolution loop turns into a question to the shop rather than a guess. That
// is the property that makes this work for cars, where no list could ever be
// complete - a "Toyota Avanza" nobody catalogued still gets asked about.
//
// The live failure (Joh's Matics, Siargao). The traveller declared an automatic
// 125cc scooter. The shop wrote, in one breath:
//
//     "for the Honda beat sir 400 pesos sir for the honda click 125 500 pesos
//      since you rent for 4 days"
//
// Two vehicles, two prices. The Honda BeAT is a 110cc; the Click 125 is the one
// the traveller asked for. The app took 400 and put "Joh's Matics ₱400/day" up
// as BEST PRICE - a bike the traveller's declared licence does not cover.
//
// Nothing was broken in the parser. The words next to "400" were "Honda beat",
// which names no displacement, so every check passed: the class word said
// "scooter", no cc contradicted anything, and an unnamed displacement defaulted
// to "must be theirs". The system had no way to know what a BeAT *is*.
//
// That is a KNOWLEDGE gap, and knowledge belongs in a table, not in an if.
// This file is that table. It is used two ways, and both matter:
//
//   1. Deterministically, by `identity.ts`, to resolve what a shop named and
//      judge it against what the traveller declared.
//   2. As GROUND TRUTH IN THE PROMPT: the models a reply mentions are rendered
//      into the extractor's context ("Honda BeAT = 110cc automatic scooter"),
//      so the language model reasons from the same facts the code checks
//      against instead of guessing from the name.
//
// Adding a model is a data edit. No caller changes, no branch is added, and the
// same entry improves the parser, the prompt and the UI at once.

import type { VehicleClassKind, TransmissionKind, VehicleAttributes } from "./spec";

export type { VehicleClassKind, TransmissionKind };

export interface VehicleModel {
  /** Canonical display name, as a traveller would recognise it. */
  name: string;
  /** Everything a shop might type, lowercase. Matched on word boundaries. */
  aliases: string[];
  make?: string;
  class: VehicleClassKind;
  transmission: TransmissionKind;
  /**
   * Every displacement this nameplate is sold as, smallest first. A single
   * entry means the name alone pins the engine size - which is exactly what
   * makes "Honda Beat" decidable without the shop spelling out "110cc".
   */
  displacementsCc: number[];
  /** Cars: how many the nameplate legally seats, when the name settles it. */
  seats?: number;
  /** Shown to the traveller and to the model when the name needs explaining. */
  note?: string;
}

// Ordered longest-alias-first at match time, so "click 160" is never read as
// "click". Displacements are the ones actually rented in SE Asia; where a
// nameplate genuinely spans sizes, every size is listed and the name alone is
// therefore NOT decisive - which the resolver reports honestly rather than
// guessing.
export const VEHICLE_CATALOGUE: VehicleModel[] = [
  // ---- Honda scooters -----------------------------------------------------
  {
    name: "Honda BeAT",
    make: "Honda",
    aliases: ["beat", "beat fi", "honda beat", "beat street"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [110],
    note: "110cc - a size below the common 125 rental scooter",
  },
  {
    name: "Honda Click 125",
    make: "Honda",
    aliases: ["click 125", "click125", "click i", "clicki"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [125],
  },
  {
    name: "Honda Click 160",
    make: "Honda",
    aliases: ["click 160", "click160"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [160],
  },
  {
    name: "Honda Click",
    make: "Honda",
    aliases: ["click", "honda click"],
    class: "scooter",
    transmission: "automatic",
    // The bare name is sold as both - so it does NOT pin the size on its own.
    displacementsCc: [125, 160],
  },
  {
    name: "Honda Scoopy",
    make: "Honda",
    aliases: ["scoopy", "honda scoopy"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [110, 125, 160],
  },
  {
    name: "Honda Vario",
    make: "Honda",
    aliases: ["vario", "honda vario"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [110, 125, 160],
  },
  {
    name: "Honda PCX",
    make: "Honda",
    aliases: ["pcx", "honda pcx", "pcx160", "pcx 160", "pcx150", "pcx 150"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [150, 160],
    note: "a bigger touring scooter, above the common 125 class",
  },
  {
    name: "Honda ADV",
    make: "Honda",
    aliases: ["adv", "adv160", "adv 160", "adv150", "adv 150", "honda adv"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [150, 160],
  },
  {
    name: "Honda Airblade",
    make: "Honda",
    aliases: ["airblade", "air blade"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [125, 160],
  },
  {
    name: "Honda Dio",
    make: "Honda",
    aliases: ["dio", "honda dio"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [110, 125],
  },
  // ---- Yamaha scooters ----------------------------------------------------
  {
    name: "Yamaha Mio",
    make: "Yamaha",
    aliases: ["mio", "yamaha mio", "mio sporty", "mio i", "mio soul", "mio gear"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [115, 125],
    note: "115-125cc depending on the variant",
  },
  {
    name: "Yamaha NMAX",
    make: "Yamaha",
    aliases: ["nmax", "n-max", "n max", "yamaha nmax"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [155],
    note: "155cc - a class above a 125",
  },
  {
    name: "Yamaha Aerox",
    make: "Yamaha",
    aliases: ["aerox", "yamaha aerox"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [155],
    note: "155cc - a class above a 125",
  },
  {
    name: "Yamaha Fazzio",
    make: "Yamaha",
    aliases: ["fazzio", "yamaha fazzio"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [125],
  },
  {
    name: "Yamaha Fino",
    make: "Yamaha",
    aliases: ["fino", "yamaha fino"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [115, 125],
  },
  {
    name: "Yamaha Filano",
    make: "Yamaha",
    aliases: ["filano", "yamaha filano", "grand filano"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [125],
  },
  {
    name: "Yamaha XMAX",
    make: "Yamaha",
    aliases: ["xmax", "x-max", "x max"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [250, 300],
  },
  // ---- Other scooters -----------------------------------------------------
  {
    name: "Vespa",
    make: "Piaggio",
    aliases: ["vespa", "sprint", "primavera"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [125, 150],
  },
  {
    name: "Suzuki Burgman",
    make: "Suzuki",
    aliases: ["burgman"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [125, 400],
  },
  {
    name: "Honda Forza",
    make: "Honda",
    aliases: ["forza"],
    class: "scooter",
    transmission: "automatic",
    displacementsCc: [300, 350],
  },
  // ---- Manual / semi-automatic bikes: a different licence, always ---------
  {
    name: "Honda Wave",
    make: "Honda",
    aliases: ["wave", "honda wave", "wave alpha", "wave rsx"],
    class: "motorbike",
    transmission: "semi-automatic",
    displacementsCc: [110, 125],
    note: "semi-automatic - it has gears, so it is not an automatic scooter",
  },
  {
    name: "Honda Dream",
    make: "Honda",
    aliases: ["dream", "honda dream", "super cub", "cub"],
    class: "motorbike",
    transmission: "semi-automatic",
    displacementsCc: [110, 125],
    note: "semi-automatic - it has gears",
  },
  {
    name: "Suzuki Raider",
    make: "Suzuki",
    aliases: ["raider", "raider 150", "raider150"],
    class: "motorbike",
    transmission: "manual",
    displacementsCc: [150],
  },
  {
    name: "Yamaha Sniper",
    make: "Yamaha",
    aliases: ["sniper", "sniper 150", "mx king"],
    class: "motorbike",
    transmission: "manual",
    displacementsCc: [150],
  },
  {
    name: "Honda XR",
    make: "Honda",
    aliases: ["xr", "xr150", "xr 150", "xr155", "xr 155"],
    class: "motorbike",
    transmission: "manual",
    displacementsCc: [150, 155],
    note: "a manual trail bike",
  },
  {
    name: "Honda CRF",
    make: "Honda",
    aliases: ["crf", "crf150", "crf 150", "crf250", "crf 250", "crf300", "crf 300"],
    class: "motorbike",
    transmission: "manual",
    displacementsCc: [150, 250, 300],
    note: "a manual dirt bike",
  },
  {
    name: "Kawasaki KLX",
    make: "Kawasaki",
    aliases: ["klx", "klx150", "klx 150", "klx250", "klx 250"],
    class: "motorbike",
    transmission: "manual",
    displacementsCc: [150, 250],
    note: "a manual dirt bike",
  },
  {
    name: "Yamaha TTR",
    make: "Yamaha",
    aliases: ["ttr", "tt-r"],
    class: "motorbike",
    transmission: "manual",
    displacementsCc: [125, 250],
    note: "a manual dirt bike",
  },
  {
    name: "Royal Enfield",
    make: "Royal Enfield",
    aliases: ["royal enfield", "enfield", "himalayan", "classic 350", "meteor"],
    class: "motorbike",
    transmission: "manual",
    displacementsCc: [350, 411],
  },
  {
    name: "Kawasaki Ninja",
    make: "Kawasaki",
    aliases: ["ninja"],
    class: "motorbike",
    transmission: "manual",
    displacementsCc: [250, 400],
  },
  // ---- Cars. The same machinery, a different attribute set --------------
  //
  // Cars are where a name settles LESS, not more: one nameplate spans gearboxes,
  // engines and seat counts. That is exactly why the catalogue reports what the
  // name does and does not settle, and lets the resolution loop ask about the
  // rest instead of assuming.
  {
    name: "Toyota Vios",
    make: "Toyota",
    aliases: ["vios", "toyota vios", "yaris sedan"],
    class: "car",
    // Rental fleets are overwhelmingly automatic, but "overwhelmingly" is not
    // "certainly" - the resolver treats a multi-value attribute as unresolved.
    transmission: "automatic",
    displacementsCc: [1300, 1500],
    seats: 5,
  },
  {
    name: "Toyota Avanza",
    make: "Toyota",
    aliases: ["avanza", "toyota avanza"],
    class: "car",
    transmission: "automatic",
    displacementsCc: [1300, 1500],
    seats: 7,
    note: "a 7-seat MPV",
  },
  {
    name: "Toyota Innova",
    make: "Toyota",
    aliases: ["innova", "toyota innova"],
    class: "car",
    transmission: "automatic",
    displacementsCc: [2000, 2400],
    seats: 7,
  },
  {
    name: "Toyota Fortuner",
    make: "Toyota",
    aliases: ["fortuner", "toyota fortuner"],
    class: "car",
    transmission: "automatic",
    displacementsCc: [2400, 2800],
    seats: 7,
  },
  {
    name: "Mitsubishi Xpander",
    make: "Mitsubishi",
    aliases: ["xpander", "mitsubishi xpander"],
    class: "car",
    transmission: "automatic",
    displacementsCc: [1500],
    seats: 7,
  },
  {
    name: "Suzuki Ertiga",
    make: "Suzuki",
    aliases: ["ertiga", "suzuki ertiga"],
    class: "car",
    transmission: "automatic",
    displacementsCc: [1500],
    seats: 7,
  },
  {
    name: "Honda Brio",
    make: "Honda",
    aliases: ["brio", "honda brio"],
    class: "car",
    transmission: "automatic",
    displacementsCc: [1200],
    seats: 5,
  },
  {
    name: "Toyota Wigo",
    make: "Toyota",
    aliases: ["wigo", "toyota wigo", "agya"],
    class: "car",
    transmission: "automatic",
    displacementsCc: [1000],
    seats: 5,
  },
  {
    name: "Suzuki Jimny",
    make: "Suzuki",
    aliases: ["jimny", "suzuki jimny"],
    class: "car",
    transmission: "manual",
    displacementsCc: [1500],
    seats: 4,
    note: "a small 4x4 - only 4 seats",
  },
  // The rest of what a rental fleet in these markets actually holds. A car
  // nameplate the catalogue does not know cannot settle its own class, so the
  // gate asks instead of confirming - correct, but it asks about the most
  // ordinary rental cars there are, which reads as an agent that knows nothing
  // about cars. These are the common ones.
  {
    name: "Toyota Yaris",
    make: "Toyota",
    aliases: ["yaris", "toyota yaris"],
    class: "car",
    transmission: "automatic",
    displacementsCc: [1200, 1500],
    seats: 5,
  },
  {
    name: "Honda City",
    make: "Honda",
    aliases: ["honda city"],
    class: "car",
    transmission: "automatic",
    displacementsCc: [1500],
    seats: 5,
  },
  {
    name: "Honda Jazz",
    make: "Honda",
    aliases: ["jazz", "honda jazz", "honda fit"],
    class: "car",
    transmission: "automatic",
    displacementsCc: [1500],
    seats: 5,
  },
  {
    name: "Nissan Almera",
    make: "Nissan",
    aliases: ["almera", "nissan almera"],
    class: "car",
    transmission: "automatic",
    displacementsCc: [1000, 1200],
    seats: 5,
  },
  {
    name: "Mitsubishi Mirage",
    make: "Mitsubishi",
    aliases: ["mirage", "mitsubishi mirage", "attrage"],
    class: "car",
    transmission: "automatic",
    displacementsCc: [1200],
    seats: 5,
  },
  {
    name: "Suzuki Swift",
    make: "Suzuki",
    aliases: ["swift", "suzuki swift"],
    class: "car",
    transmission: "automatic",
    displacementsCc: [1200, 1400],
    seats: 5,
  },
  {
    name: "Kia Picanto",
    make: "Kia",
    aliases: ["picanto", "kia picanto"],
    class: "car",
    transmission: "automatic",
    displacementsCc: [1000, 1200],
    seats: 5,
  },
  {
    name: "Hyundai Accent",
    make: "Hyundai",
    aliases: ["accent", "hyundai accent"],
    class: "car",
    transmission: "automatic",
    displacementsCc: [1400, 1600],
    seats: 5,
  },
  {
    name: "Toyota Hiace",
    make: "Toyota",
    aliases: ["hiace", "toyota hiace", "commuter van"],
    class: "car",
    transmission: "manual",
    displacementsCc: [2500, 2800],
    seats: 12,
    note: "a passenger van",
  },
];

const ALIAS_INDEX: Array<{ alias: string; model: VehicleModel; rx: RegExp }> = VEHICLE_CATALOGUE
  .flatMap((model) => model.aliases.map((alias) => ({ alias, model })))
  .map(({ alias, model }) => ({
    alias,
    model,
    // Word-boundaried so "beat" never fires inside "beating" and "adv" never
    // inside "advance" - the class of false positive that makes a catalogue
    // worse than no catalogue.
    rx: new RegExp(`(?<![a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "gi"),
  }));

export interface CatalogueHit {
  model: VehicleModel;
  /** Where in the text the name was found - lets callers pair it with a price. */
  index: number;
  /** The exact words the shop typed. */
  matched: string;
}

/**
 * How much a candidate reading SETTLES, when two overlap.
 *
 * "honda click 125" can be read as `Honda Click` (11 characters) or as
 * `Click 125` (9). Longest-string-wins picks the first, which is the WORSE
 * reading: the bare Click is sold as a 125 and a 160, so that reading leaves
 * the engine size unresolved when the shop had just spelled it out. So the tie
 * is broken by what the reading DETERMINES - a nameplate that pins the engine
 * size beats one that does not - and only then by length.
 */
function specificity(model: VehicleModel): number {
  return model.displacementsCc.length === 1 ? 1 : 0;
}

/**
 * Every catalogued model named in the text, in the order they appear.
 *
 * Overlapping readings are resolved by specificity, then by span, and the
 * winner consumes its characters so nothing inside it can match again - one
 * mention is one vehicle.
 */
export function findModels(text: string): CatalogueHit[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const candidates: Array<{ model: VehicleModel; start: number; end: number; matched: string }> = [];
  for (const { model, rx } of ALIAS_INDEX) {
    rx.lastIndex = 0;
    for (const m of lower.matchAll(rx)) {
      const start = m.index ?? 0;
      candidates.push({ model, start, end: start + m[0].length, matched: m[0] });
    }
  }
  candidates.sort(
    (a, b) =>
      specificity(b.model) - specificity(a.model) ||
      b.end - b.start - (a.end - a.start) ||
      a.start - b.start
  );
  const taken: Array<{ start: number; end: number }> = [];
  const hits: CatalogueHit[] = [];
  for (const c of candidates) {
    if (taken.some((t) => c.start < t.end && c.end > t.start)) continue;
    taken.push({ start: c.start, end: c.end });
    hits.push({ model: c.model, index: c.start, matched: c.matched });
  }
  return hits.sort((a, b) => a.index - b.index);
}

/**
 * What the NAME alone settles, as general attributes.
 *
 * Deliberately conservative: a nameplate sold in several engine sizes settles
 * its class and gearbox but NOT its displacement, and that gap is reported as
 * absent rather than filled with the most common value. Filling it in is how a
 * guess becomes a quote.
 */
export function attributesOf(model: VehicleModel): VehicleAttributes {
  return {
    class: model.class,
    transmission: model.transmission,
    displacementCc: decisiveDisplacement(model),
    seats: model.seats,
  };
}

/** The single best-known displacement for a model, or undefined when it spans sizes. */
export function decisiveDisplacement(model: VehicleModel): number | undefined {
  return model.displacementsCc.length === 1 ? model.displacementsCc[0] : undefined;
}

/** One line of ground truth, for a prompt or a card. */
export function describeModel(model: VehicleModel): string {
  const cc =
    model.displacementsCc.length === 1
      ? `${model.displacementsCc[0]}cc`
      : `${model.displacementsCc.join("/")}cc depending on variant`;
  const tx =
    model.transmission === "automatic"
      ? "automatic"
      : model.transmission === "semi-automatic"
        ? "semi-automatic (has gears)"
        : "manual";
  return `${model.name} = ${cc} ${tx} ${model.class}${model.note ? ` - ${model.note}` : ""}`;
}

/**
 * The facts block handed to the language model for ONE reply: only the models
 * that reply actually names, so the context stays small and every line is
 * relevant. This is what turns "the model guessed" into "the model was told".
 */
export function catalogueFactsFor(text: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const hit of findModels(text)) {
    if (seen.has(hit.model.name)) continue;
    seen.add(hit.model.name);
    lines.push(describeModel(hit.model));
  }
  return lines.join("\n");
}
