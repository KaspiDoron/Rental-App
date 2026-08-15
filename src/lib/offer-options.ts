// VEHICLE OPTIONS - a shop's reply is a MENU, not a number.
//
// The live failure this exists for (Marlin Krabi, 26 Jul):
//   us:   "after a scooter (125cc) for about 5 days. How much per day?"
//   shop: "Hi! Normal scooters? Some models 200 and some new 250/day"
//   shop: "It depends on what you choose, 1000 or 1250 total. Deposit 3000 or $EUR100"
//
// The shop offered a CHOICE and asked us a question. The engine had no way to
// hold a choice - `ExtractedOffer` carries exactly one `pricePerDay` - so the
// 200 tier was discarded, the app showed a bare "250/day", and the agent
// answered "what's your best price per day?" as if nothing had been said. On a
// second thread the same collapse read the ambiguity as "this shop does not
// have our vehicle" and closed the conversation.
//
// The fix is a wider MODEL, not a wider decision tree: an offer is a SET of
// options, each with the facts a traveller actually picks on (price, how old,
// mileage, a photo). What is still MISSING per option is computed here as
// `gaps`, so the negotiator knows exactly what to ask next without any rule
// keyed on the shop's wording.
//
// Pure and unit-tested, in the style of src/lib/spte/thread-facts.ts: derived
// from the thread every turn, so nothing persists and nothing can go stale.

import { extractQuotedPrices, type RentalPriceHit, type VehicleClassHint } from "./wa/price-extract";

export type OptionCondition = "new" | "older" | "unknown";
/** What we still need before this option can be compared or booked. */
export type OptionGap = "mileage" | "photo" | "condition" | "deposit";

export interface VehicleOption {
  /** Stable across turns so later facts attach to the right tier. */
  key: string;
  /** The shop's own words for this tier ("new", "older model", "Click 125"). */
  label: string;
  pricePerDay: number;
  currency?: string;
  condition: OptionCondition;
  /** Only when the shop actually stated it - never estimated. */
  mileageKm?: number;
  model?: string;
  depositNote?: string;
  /** Storage refs for photos the shop sent of THIS option. */
  photoRefs: string[];
  source: "text" | "photo";
  gaps: OptionGap[];
  /**
   * When this tier came off a DURATION LADDER, the stay it applies to. A board
   * row is not a choice the traveller can make - it is a rate they qualify for
   * by staying that long - so the UI must say which, and the negotiator must
   * never quote a row the traveller's dates do not reach.
   */
  minDays?: number;
  maxDays?: number;
  /** The shop's own words for the range ("3-7 days", "Monthly"). */
  tierLabel?: string;
  /**
   * FALSE when the board CROSSED THIS ROW OUT (a red X, a line through it).
   *
   * A struck-through row is still a row - the board really does list it, and
   * "never drop a tier" applies - but the model is not on offer, so its price
   * is never quoted. Undefined means the board said nothing either way.
   */
  available?: boolean;
}

const MODEL_NAMES =
  "\\b(?:click|scoopy|fino|filano|nmax|pcx|aerox|vario|beat|mio|vespa|forza|adv|xmax|wave|dream|raider|sniper|crf|klx|xr)";

/**
 * THE SPEC THE TRAVELLER DECLARED. Every option must match it.
 *
 * The live failure (Cee Moto Siargao, 26 Jul): the traveller asked for a 125cc
 * automatic scooter; the shop replied with its entire price board - 110cc Beat,
 * 125cc Click, 150cc, 200cc XR, 250cc Scrambler, at eight prices, twice over
 * (standard and 8-day rates). The card offered all seventeen as things to pick.
 *
 * That is wrong on two counts, and the second one matters more:
 *   - It is not what they asked for. A menu is only useful when every row is a
 *     candidate; a board of everything the shop owns is just the board again.
 *   - THEY ARE NOT LICENSED FOR IT. The traveller declared an IDP for the class
 *     they searched. Presenting a 200cc trail bike as "pick the one you want",
 *     and letting an agent bargain for it, invites them to ride something their
 *     licence and their insurance do not cover.
 *
 * So the filter is not a display nicety - it is the same gate as the licence
 * disclaimer, applied to the data.
 */
export interface VehicleSpec {
  vehicleClass?: VehicleClassHint;
  /** What the traveller asked for, e.g. 125. */
  engineSizeCc?: number;
  transmission?: "automatic" | "manual" | "any";
}

/** A displacement the shop typed: "110cc", "125 cc", "Click 150", "XR 200cc". */
const CC_RX = /\b(\d{2,4})\s*(?:cc|ccm)\b/i;
/** A model name followed by a bare displacement ("Honda Click 150", "XR 200"). */
const MODEL_CC_RX = new RegExp(`${MODEL_NAMES}\\s*-?\\s*(\\d{2,4})\\b`, "i");

export function ccIn(line: string): number | undefined {
  const m = (line || "").match(CC_RX) ?? (line || "").match(MODEL_CC_RX);
  const n = m ? parseInt(m[m.length - 1], 10) : NaN;
  // Real scooters/bikes sit in 50..1300cc; anything else is a price or a year.
  return Number.isFinite(n) && n >= 50 && n <= 1300 ? n : undefined;
}

/**
 * Same displacement, allowing only the badge rounding manufacturers actually
 * use (a "125" is sold as 124.8cc; a 150 is a different bike and often a
 * different licence). Deliberately tight: the owner's rule is the declared
 * vehicle, not "something like it".
 */
export function ccMatches(want: number, got: number): boolean {
  return Math.abs(want - got) <= Math.max(5, want * 0.06);
}

/**
 * Does this option line describe the vehicle the traveller declared?
 *
 * Judged on what the shop WROTE next to the price - never on the price itself.
 * A line that names nothing (a bare "350/day") stays: it is most likely the
 * answer to the question we asked, and dropping it would lose real offers.
 */
export function matchesSpec(line: string, spec: VehicleSpec): boolean {
  if (!spec || (!spec.engineSizeCc && !spec.vehicleClass)) return true;
  // 1) A named class that is not ours ends it: a 200cc trail bike is not a
  //    scooter no matter what it costs.
  const cls = classOfLine(line);
  if (cls && spec.vehicleClass && cls !== spec.vehicleClass) return false;
  // 2) A named displacement must be the one they asked for.
  const cc = ccIn(line);
  if (cc !== undefined && spec.engineSizeCc && !ccMatches(spec.engineSizeCc, cc)) return false;
  // 3) A manual bike fails an automatic request even without a displacement.
  if (spec.transmission === "automatic" && MANUAL_RX.test(line)) return false;
  return true;
}

/** Scooter vs motorbike vs car, from the words on the line. */
const SCOOTER_LINE =
  /\b(scooter|scoopy|click|fino|filano|nmax|pcx|vespa|beat|mio|aerox|vario|moped|automatic|fazzio|matic)\b/i;
const MOTORBIKE_LINE =
  /\b(motor\s?bike|motorcycle|manual|semi\s?auto|sportbike|dirt\s?bike|scrambler|cafe\s?racer|enduro|trail|xr|klx|crf|ttr|raider|sniper)\b/i;
const CAR_LINE = /\b(car|sedan|suv|hatchback|van|mpv|pickup|4x4|jeep|multicab)\b/i;
const MANUAL_RX = /\b(manual|semi\s?auto|clutch|geared?|scrambler|dirt\s?bike|enduro|xr|klx|crf|ttr)\b/i;

/** Does this line name a vehicle at all (a class, a model, or a displacement)? */
export function namesVehicle(line: string): boolean {
  return Boolean(classOfLine(line) || modelIn(line) || ccIn(line));
}

/**
 * A PRICE BOARD HAS HEADINGS, AND THEY BIND THE ROWS UNDER THEM.
 *
 * The live failure: the shop's board was headed "155 CC" and its rows read
 * "1-2 days - 650", "3-7 days - 600"... Not one row named a vehicle, so every
 * spec check passed and a traveller who asked for 125cc was quoted off the
 * 155cc board. The heading is the only place the vehicle is written, and it
 * governs everything below it until the next heading.
 *
 * Returns, for each line of the message, the nearest heading above it.
 */
export function sectionHeaders(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let current = "";
  for (const raw of (text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // A heading names a vehicle and is NOT itself a priced row - a row like
    // "Click 125 - 400/day" describes itself and must not govern its siblings.
    if (namesVehicle(line) && !/\d{1,3}\s*days?\b/i.test(line)) {
      current = line;
      continue;
    }
    if (current) out.set(line, current);
  }
  return out;
}

function classOfLine(line: string): VehicleClassHint {
  // Two-wheel words win over car words, mirroring price-extract's lineClass:
  // a "car & scooter rental" header must not misclassify the scooter row.
  if (MOTORBIKE_LINE.test(line) && !SCOOTER_LINE.test(line)) return "motorbike";
  if (SCOOTER_LINE.test(line)) return "scooter";
  if (MOTORBIKE_LINE.test(line)) return "motorbike";
  if (CAR_LINE.test(line)) return "car";
  return undefined;
}

/** Words a shop uses for the newer/older end of its fleet. */
const NEW_RX = /\b(new|newer|latest|brand[\s-]?new|20(?:2[3-9]|3\d))\b/i;
const OLDER_RX = /\b(old|older|used|second[\s-]?hand|basic|standard|cheap(?:er)?|normal)\b/i;

/**
 * Does this message SIGNAL that the price depends on a choice, even when we
 * could not parse two clean numbers? "It depends what you choose", "some models
 * X some Y", "we have different ones". This is what tells the negotiator to
 * resolve the menu instead of haggling a number the traveller has not picked.
 */
const VARIANCE_RX =
  /\b(depends? (?:on )?(?:what|which|the)\b|different (?:models?|bikes?|scooters?|cars?|ones?|prices?)|some (?:models?|bikes?|are)\b|which (?:one|model|type)|we have (?:a few|several|many|two|three)|from \d+\s*(?:to|-|until)\s*\d+)/i;

export function signalsVariance(text: string): boolean {
  return VARIANCE_RX.test(text || "");
}

/** The shop's own label for a tier, taken from the line the price sat on. */
function labelFor(line: string, condition: OptionCondition): string {
  const model = modelIn(line);
  if (model) return model;
  if (condition === "new") return "Newer model";
  if (condition === "older") return "Older model";
  return "Option";
}

/** A concrete model name the shop typed ("Click 125", "NMAX", "Fino"). */
const MODEL_RX =
  /\b(click|scoopy|fino|filano|nmax|pcx|aerox|vario|beat|mio|vespa|forza|adv|xmax|wave|dream|raider|sniper|crf|klx|xr)\s*-?\s*(\d{2,3})?\b/i;
function modelIn(line: string): string | undefined {
  const m = (line || "").match(MODEL_RX);
  if (!m) return undefined;
  const name = m[1].replace(/^./, (c) => c.toUpperCase());
  return m[2] ? `${name} ${m[2]}` : name;
}

function conditionOf(line: string): OptionCondition {
  // NEW wins when both appear ("new and old models") - the pricier tier is the
  // one a bare "new" most often attaches to, and `gaps` will make us ask anyway.
  if (NEW_RX.test(line)) return "new";
  if (OLDER_RX.test(line)) return "older";
  return "unknown";
}

/** A mileage the shop actually stated ("40000 km", "40k km"). */
const MILEAGE_RX = /\b(\d{1,3}(?:[.,\s]?\d{3})*|\d+(?:\.\d+)?\s*k)\s*(?:km|kms|kilometers?|kilometres?)\b/i;
export function mileageIn(line: string): number | undefined {
  const m = (line || "").match(MILEAGE_RX);
  if (!m) return undefined;
  const raw = m[1].trim().toLowerCase();
  const n = raw.endsWith("k")
    ? Math.round(parseFloat(raw) * 1000)
    : parseInt(raw.replace(/[.,\s]/g, ""), 10);
  return Number.isFinite(n) && n > 0 && n < 2_000_000 ? n : undefined;
}

/**
 * The words that describe the amount at `index` - its own clause.
 *
 * Segmenting on EVERY comma was wrong: "older Wave 150 at 200/day, 40000 km"
 * put the mileage in a different segment from the bike it belongs to. The real
 * boundary is the next *amount*, because that is where the next option starts.
 * So the window runs to the last separator before the neighbouring amount, and
 * to the whole line when this amount is the only one on it (a price-sheet row IS
 * one option).
 */
const SEPARATOR = /[,;.]|\bor\b|\band\b/gi;
function describingWindow(line: string, index: number | undefined, siblings: number[]): string {
  if (index === undefined || !line) return line;
  const before = siblings.filter((i) => i < index).pop();
  const after = siblings.find((i) => i > index);
  const start = before === undefined ? 0 : lastSeparatorBetween(line, before, index);
  const end = after === undefined ? line.length : lastSeparatorBetween(line, index, after);
  return line.slice(start, end);
}

/** The end of the last separator strictly between two amounts (else midpoint). */
function lastSeparatorBetween(line: string, from: number, to: number): number {
  let at = -1;
  for (const m of line.slice(from, to).matchAll(SEPARATOR)) {
    at = from + (m.index ?? 0) + m[0].length;
  }
  return at >= 0 ? at : to;
}

/**
 * The tier's identity is its PRICE. Condition, model and mileage are things we
 * learn later - keying on them would fork one tier into two the moment the shop
 * finally says which bike is which.
 */
function keyFor(price: number): string {
  return `tier-${Math.round(price)}`;
}

function gapsFor(o: Omit<VehicleOption, "gaps">): OptionGap[] {
  const gaps: OptionGap[] = [];
  if (o.condition === "unknown") gaps.push("condition");
  if (o.mileageKm === undefined) gaps.push("mileage");
  if (o.photoRefs.length === 0) gaps.push("photo");
  if (!o.depositNote) gaps.push("deposit");
  return gaps;
}

/**
 * Build the option set from one shop message. Returns [] when the shop named a
 * single price (the ordinary case - one option is not a menu worth surfacing).
 *
 * `hits` comes from extractQuotedPrices(...).allOffers, which already carries
 * the LINE each amount sat on - that line is where the condition, model and
 * mileage words live.
 */
export function optionsFromHits(
  hits: RentalPriceHit[],
  opts: {
    depositNote?: string;
    source?: "text" | "photo";
    spec?: VehicleSpec;
    /** Line -> the board heading above it, from `sectionHeaders`. */
    headers?: Map<string, string>;
  } = {}
): VehicleOption[] {
  if (hits.length < 2) return [];
  const source = opts.source ?? "text";
  const spec = opts.spec ?? {};
  const out: VehicleOption[] = [];
  const used = new Set<string>();
  // Amounts that share a line are neighbours; each one's clause ends where the
  // next begins. Built once so every hit knows its siblings.
  const siblingsByLine = new Map<string, number[]>();
  for (const h of hits) {
    if (h.index === undefined) continue;
    const arr = siblingsByLine.get(h.line ?? "") ?? [];
    arr.push(h.index);
    siblingsByLine.set(h.line ?? "", arr);
  }
  for (const arr of siblingsByLine.values()) arr.sort((a, b) => a - b);

  for (const h of hits) {
    if (!(h.pricePerDay > 0)) continue;
    // LOCALITY. "new one 250/day, old one 200/day" is one line describing two
    // different bikes - reading the whole line would label both "new". Each
    // amount is described by the words around IT.
    const own = describingWindow(h.line ?? "", h.index, siblingsByLine.get(h.line ?? "") ?? []);
    // A board row names no vehicle of its own - its heading does. Fall back to
    // the heading ONLY when the row itself is silent, so a row that names its
    // own bike still speaks for itself.
    const heading = opts.headers?.get((h.line ?? "").trim());
    const line = namesVehicle(own) || !heading ? own : `${heading} ${own}`;
    // ONLY THE VEHICLE THEY ASKED FOR. Judged on the shop's own words beside
    // this amount, so one row of a price board can be kept while its
    // neighbours - a 200cc trail bike, a 110cc Beat - are dropped. The
    // traveller's licence declaration covers the class they searched, and
    // nothing else may be offered as a choice or bargained for.
    if (!matchesSpec(line, spec)) continue;
    const condition = conditionOf(line);
    const base = {
      key: keyFor(h.pricePerDay),
      label: labelFor(line, condition),
      pricePerDay: h.pricePerDay,
      currency: h.currency,
      condition,
      mileageKm: mileageIn(line),
      model: modelIn(line),
      depositNote: opts.depositNote,
      photoRefs: [] as string[],
      source,
      minDays: h.minDays,
      maxDays: h.maxDays,
      tierLabel: h.tierLabel,
    };
    if (used.has(base.key)) continue;
    used.add(base.key);
    out.push({ ...base, gaps: gapsFor(base) });
  }
  // Cheapest first: the traveller reads price, and the negotiator's floor logic
  // reasons from the bottom of the menu upward.
  out.sort((a, b) => a.pricePerDay - b.pricePerDay);

  // When the shop distinguished the tiers only by price, say so honestly rather
  // than inventing "new"/"older": two unlabeled tiers become "Cheaper option" /
  // "Pricier option" so the UI never asserts a condition nobody stated.
  if (out.length === 2 && out.every((o) => o.condition === "unknown" && !o.model)) {
    out[0].label = "Cheaper option";
    out[1].label = "Pricier option";
  }
  return out;
}

/**
 * Merge a newly-read option set into what the thread already knew. Facts only
 * ever ACCUMULATE - a later turn that mentions mileage must enrich the tier, not
 * replace it, and a turn that mentions nothing must not erase it. Keyed on
 * condition+price so the same tier restated is the same tier.
 */
export function mergeOptions(prev: VehicleOption[], next: VehicleOption[]): VehicleOption[] {
  if (!next.length) return prev;
  const byKey = new Map(prev.map((o) => [o.key, o]));
  for (const n of next) {
    const old = byKey.get(n.key);
    if (!old) {
      byKey.set(n.key, n);
      continue;
    }
    const merged: Omit<VehicleOption, "gaps"> = {
      key: old.key,
      label: n.model ? n.label : old.label,
      pricePerDay: n.pricePerDay,
      currency: n.currency ?? old.currency,
      condition: old.condition !== "unknown" ? old.condition : n.condition,
      mileageKm: old.mileageKm ?? n.mileageKm,
      model: old.model ?? n.model,
      depositNote: old.depositNote ?? n.depositNote,
      photoRefs: [...new Set([...old.photoRefs, ...n.photoRefs])],
      source: old.source,
      minDays: old.minDays ?? n.minDays,
      maxDays: old.maxDays ?? n.maxDays,
      tierLabel: old.tierLabel ?? n.tierLabel,
    };
    byKey.set(n.key, { ...merged, gaps: gapsFor(merged) });
  }
  return [...byKey.values()].sort((a, b) => a.pricePerDay - b.pricePerDay);
}

/**
 * The shop's whole menu, read from every message it has sent in this thread.
 *
 * Deliberately DERIVED rather than stored: the thread history is already the
 * durable state (the same principle src/lib/spte/thread-facts.ts is built on),
 * so there is no options table to migrate, nothing to keep in sync, and no way
 * for a stored menu to go stale against the conversation it came from.
 */
export function optionsFromThread(
  shopMessages: string[],
  opts: {
    vehicleClass?: VehicleClassHint;
    /** The displacement the traveller declared - the menu is scoped to it. */
    engineSizeCc?: number;
    transmission?: "automatic" | "manual" | "any";
    durationDays?: number;
    localCurrency?: string;
    depositNote?: string;
  } = {}
): VehicleOption[] {
  const spec: VehicleSpec = {
    vehicleClass: opts.vehicleClass,
    engineSizeCc: opts.engineSizeCc,
    transmission: opts.transmission,
  };
  let acc: VehicleOption[] = [];
  for (const msg of shopMessages) {
    if (!msg || !msg.trim()) continue;
    const quoted = extractQuotedPrices(msg, {
      vehicleClass: opts.vehicleClass,
      durationDays: opts.durationDays,
      localCurrency: opts.localCurrency,
    });
    acc = mergeOptions(
      acc,
      optionsFromHits(quoted.allOffers, {
        depositNote: opts.depositNote,
        spec,
        // A board's heading is the only place its vehicle is written; without
        // it every row of a 155cc board passes a 125cc traveller's spec check.
        headers: sectionHeaders(msg),
      })
    );
  }
  return acc;
}

/** The shape every priced surface shares - kept structural so this stays pure. */
export interface PricedOffer {
  pricePerDay: number;
  currency: string;
  totalPrice: number;
}

/**
 * Narrow an offer to the tier the traveller actually chose.
 *
 * Every downstream reader takes the price straight off the offer - the booking
 * sheet, the server-side total, the bargain draft's "current price". Passing a
 * chosen option around as a SIBLING value would have meant locking the "older
 * 200" tier while booking the headline "newer 250": the same class of bug as
 * showing one price for a menu. So the choice is applied to the offer itself.
 */
export function offerForOption<O extends PricedOffer>(
  offer: O,
  option: VehicleOption,
  durationDays: number
): O {
  const days = durationDays > 0 ? durationDays : 1;
  return {
    ...offer,
    pricePerDay: option.pricePerDay,
    currency: option.currency || offer.currency,
    totalPrice: Math.round(option.pricePerDay * days),
  };
}

/**
 * Is the menu still unresolved? True while more than one tier is live and any
 * of them is missing something a traveller would need to choose. This is the
 * predicate the policy rails use to make `option-probe` legal - a fact about the
 * DATA, never a rule about the shop's wording.
 */
export function menuUnresolved(options: VehicleOption[]): boolean {
  return options.length >= 2 && options.some((o) => o.gaps.length > 0);
}

/** The single most useful thing to ask next, across the whole menu. */
export function nextGap(options: VehicleOption[]): OptionGap | null {
  const order: OptionGap[] = ["condition", "mileage", "photo", "deposit"];
  for (const g of order) {
    if (options.some((o) => o.gaps.includes(g))) return g;
  }
  return null;
}
