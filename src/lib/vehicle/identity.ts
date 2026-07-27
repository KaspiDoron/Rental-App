// VEHICLE IDENTITY - the one component that answers "whose vehicle is this?"
//
// Until now that question was answered incidentally: by whichever words happened
// to sit near a number, by a class regex, by a field the language model filled
// in. No component owned it, so nothing could be held to it - and the default
// when nobody could tell was "it must be theirs".
//
// Two live threads, one day apart, both ending with ₱400 on screen as the
// traveller's BEST PRICE for a bike they cannot legally ride:
//
//   Joh's Matics  "for the Honda beat sir 400 pesos sir for the honda click
//                  125 500 pesos"          -> 400 belongs to a 110cc BeAT
//   Coyote Way    "I already gave 500 for you. If you want 110cc 400 per day"
//                                          -> the shop TYPED 110cc next to 400
//
// The second one is the tell. The number 110 was right there in the sentence.
// Nothing was mis-parsed; there was simply no concept of a price BELONGING to a
// vehicle, so the cheapest number won.
//
// This module supplies that concept, generally:
//
//   1. IDENTITY BEFORE PRICE. Every quote is paired with the vehicle named
//      nearest to it. A reply with two vehicles is two offers.
//   2. ATTRIBUTES, NOT MODELS. A mention resolves into the attribute set from
//      spec.ts, each attribute carrying the EVIDENCE that settled it. Nothing
//      here knows what a "125" is; it compares declared attributes to resolved
//      ones, which is why it works the same for a car's seat count.
//   3. UNRESOLVED IS NOT MATCH. An attribute nobody stated and no catalogue
//      settles stays unresolved, and an unresolved DISQUALIFYING attribute is a
//      question the agent must ask - never a deal to show.

import { findModels, attributesOf, type VehicleModel } from "./catalogue";
import {
  ATTRIBUTES,
  EVIDENCE_RANK,
  disqualifyingKeys,
  describeSpec,
  type AttributeKey,
  type Evidence,
  type VehicleAttributes,
  type VehicleClassKind,
  type TransmissionKind,
} from "./spec";

export type VehicleVerdict = "match" | "mismatch" | "unknown";

/** What the traveller declared - and, by the licence disclaimer, is covered for. */
export type DeclaredVehicle = VehicleAttributes;

/** One attribute of one mention, and how confidently we know it. */
export interface ResolvedAttribute {
  value: unknown;
  evidence: Evidence;
}

export interface VehicleIdentity {
  /** The catalogue entry, when the shop named something already known. */
  model?: VehicleModel;
  /** The shop's own words - what the agent may quote back to them. */
  label: string;
  attributes: Partial<Record<AttributeKey, ResolvedAttribute>>;
  /** Character offset of the naming words, for pairing with a price. */
  index: number;
}

export interface AttributeConflict {
  key: AttributeKey;
  want: unknown;
  got: unknown;
  evidence: Evidence;
}

export interface VehicleJudgement {
  verdict: VehicleVerdict;
  /** Plain English, safe to show a traveller and to put into a prompt. */
  reason: string;
  identity: VehicleIdentity;
  /** Declared attributes this vehicle contradicts. Non-empty => mismatch. */
  conflicts: AttributeConflict[];
  /** Declared, disqualifying attributes nothing has settled yet. */
  unresolved: AttributeKey[];
}

// ---------------------------------------------------------------------------
// Reading attributes out of what a shop typed
// ---------------------------------------------------------------------------

const CC_RX = /\b(\d{2,4})\s*(?:cc|ccm)\b/i;
const CC_RX_G = /\b(\d{2,4})\s*(?:cc|ccm)\b/gi;
const SEATS_RX = /\b(\d{1,2})\s*(?:seat(?:er|s)?|pax|persons?|people)\b/i;
const MANUAL_WORDS = /\b(manual|stick|clutch|geared?|gear\s?shift)\b/i;
const SEMI_AUTO_WORDS = /\b(semi[\s-]?auto(?:matic)?|underbone)\b/i;
const AUTO_WORDS = /\b(automatic|auto|matic|cvt|twist[\s-]?and[\s-]?go|no\s?gears?)\b/i;
const SCOOTER_WORDS = /\b(scooter|moped|matic|scoot)\b/i;
const MOTORBIKE_WORDS = /\b(motor\s?bike|motorcycle|dirt\s?bike|trail|enduro|sportbike|scrambler)\b/i;
const CAR_WORDS = /\b(car|sedan|suv|hatchback|van|mpv|pickup|4x4|jeep|multicab)\b/i;
const DIESEL_RX = /\bdiesel\b/i;
const ELECTRIC_RX = /\b(electric|e-?bike|ev)\b/i;

/** A displacement plausible for a rental vehicle; anything else is a price. */
function plausibleCc(n: number): boolean {
  return Number.isFinite(n) && n >= 50 && n <= 6000;
}

function classIn(text: string): VehicleClassKind | undefined {
  if (MOTORBIKE_WORDS.test(text) && !SCOOTER_WORDS.test(text)) return "motorbike";
  if (SCOOTER_WORDS.test(text)) return "scooter";
  if (MOTORBIKE_WORDS.test(text)) return "motorbike";
  if (CAR_WORDS.test(text)) return "car";
  return undefined;
}

function transmissionIn(text: string): TransmissionKind | undefined {
  if (SEMI_AUTO_WORDS.test(text)) return "semi-automatic";
  if (MANUAL_WORDS.test(text)) return "manual";
  if (AUTO_WORDS.test(text)) return "automatic";
  return undefined;
}

/** Attributes the shop STATED in this stretch of words. Strongest evidence. */
function statedIn(text: string): VehicleAttributes {
  const out: VehicleAttributes = {};
  const cc = text.match(CC_RX);
  if (cc && plausibleCc(parseInt(cc[1], 10))) out.displacementCc = parseInt(cc[1], 10);
  const seats = text.match(SEATS_RX);
  if (seats) {
    const n = parseInt(seats[1], 10);
    if (n >= 2 && n <= 20) out.seats = n;
  }
  const tx = transmissionIn(text);
  if (tx) out.transmission = tx;
  const cls = classIn(text);
  if (cls) out.class = cls;
  if (DIESEL_RX.test(text)) out.fuel = "diesel";
  else if (ELECTRIC_RX.test(text)) out.fuel = "electric";
  return out;
}

/** Merge a weaker source under a stronger one, never over it. */
function absorb(
  into: Partial<Record<AttributeKey, ResolvedAttribute>>,
  from: VehicleAttributes,
  evidence: Evidence
): void {
  for (const key of Object.keys(from) as AttributeKey[]) {
    const value = from[key];
    if (value === undefined) continue;
    const prev = into[key];
    if (prev && EVIDENCE_RANK[prev.evidence] >= EVIDENCE_RANK[evidence]) continue;
    into[key] = { value, evidence };
  }
}

/**
 * Every vehicle the text names, each with its attributes and their evidence.
 *
 * A catalogued name and a stated attribute can BOTH be present ("honda click
 * 125", "110cc scooter"). What the shop typed about THIS vehicle always wins,
 * which is how a rare market variant survives the catalogue's general knowledge.
 */
export function identifyVehicles(text: string): VehicleIdentity[] {
  const src = text || "";
  const out: VehicleIdentity[] = [];

  for (const hit of findModels(src)) {
    const attributes: Partial<Record<AttributeKey, ResolvedAttribute>> = {};
    // Weakest first, so the strongest source ends up on top.
    absorb(attributes, attributesOf(hit.model), "catalogue");
    // Words in the same clause as the name are about this vehicle.
    const clause = src.slice(Math.max(0, hit.index - 24), hit.index + hit.matched.length + 26);
    absorb(attributes, statedIn(clause), "stated");
    out.push({ model: hit.model, label: hit.model.name, attributes, index: hit.index });
  }

  // Vehicles described with NO nameplate: "110cc 400 per day", "a 7-seater
  // automatic". This is the Coyote Way case - the decisive attribute was typed
  // with no model attached to hang it on.
  const claimed = out.map((o) => o.index);
  const near = (i: number) => claimed.some((c) => Math.abs(c - i) < 26);
  for (const m of src.matchAll(CC_RX_G)) {
    const at = m.index ?? 0;
    if (near(at)) continue;
    const n = parseInt(m[1], 10);
    if (!plausibleCc(n)) continue;
    const clause = src.slice(Math.max(0, at - 40), at + 40);
    const attributes: Partial<Record<AttributeKey, ResolvedAttribute>> = {};
    absorb(attributes, { ...statedIn(clause), displacementCc: n }, "stated");
    out.push({ label: `${n}cc`, attributes, index: at });
    claimed.push(at);
  }

  return out.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Judging one vehicle against what the traveller declared
// ---------------------------------------------------------------------------

/**
 * Is this the vehicle the traveller declared?
 *
 * A safety judgement before a shopping one: the licence disclaimer they accepted
 * covers exactly what they searched for. Only DISQUALIFYING attributes decide
 * the verdict; preferences never block a deal.
 */
export function judgeVehicle(
  identity: VehicleIdentity,
  declared: DeclaredVehicle
): VehicleJudgement {
  const keys = disqualifyingKeys(declared);
  if (keys.length === 0) {
    return {
      verdict: "match",
      reason: "no vehicle requirements were declared",
      identity,
      conflicts: [],
      unresolved: [],
    };
  }

  const conflicts: AttributeConflict[] = [];
  const unresolved: AttributeKey[] = [];

  for (const key of keys) {
    const want = declared[key];
    const got = identity.attributes[key];
    if (!got || got.value === undefined) {
      unresolved.push(key);
      continue;
    }
    if (!ATTRIBUTES[key].matches(want, got.value)) {
      conflicts.push({ key, want, got: got.value, evidence: got.evidence });
    }
  }

  if (conflicts.length > 0) {
    const c = conflicts[0];
    return {
      verdict: "mismatch",
      reason: `${identity.label}: ${ATTRIBUTES[c.key].label} is ${String(c.got)}, you asked for ${String(c.want)}`,
      identity,
      conflicts,
      unresolved,
    };
  }
  if (unresolved.length > 0) {
    return {
      verdict: "unknown",
      reason: `${identity.label}: ${unresolved
        .map((k) => ATTRIBUTES[k].label)
        .join(" and ")} not established yet`,
      identity,
      conflicts,
      unresolved,
    };
  }
  return {
    verdict: "match",
    reason: `${identity.label} is the ${describeSpec(declared)} you asked for`,
    identity,
    conflicts,
    unresolved,
  };
}

export interface PricedVehicle {
  pricePerDay: number;
  currency?: string;
  judgement: VehicleJudgement;
}

/**
 * Pair every price in a reply with the vehicle it belongs to.
 *
 * Each amount takes the NEAREST PRECEDING vehicle mention, because that is how
 * these sentences are written ("for the Honda beat sir 400 pesos"). A price
 * before any mention falls back to the nearest one after it.
 */
export function pairPricesWithVehicles(
  text: string,
  prices: Array<{ pricePerDay: number; currency?: string; index?: number }>,
  declared: DeclaredVehicle
): PricedVehicle[] {
  const vehicles = identifyVehicles(text);
  return prices.map((p) => {
    const at = p.index ?? 0;
    const before = vehicles.filter((v) => v.index <= at).pop();
    const after = vehicles.find((v) => v.index > at);
    const owner = before ?? after;
    const identity: VehicleIdentity =
      owner ?? { label: "the vehicle", attributes: attributesFromLooseText(text), index: at };
    return {
      pricePerDay: p.pricePerDay,
      currency: p.currency,
      judgement: judgeVehicle(identity, declared),
    };
  });
}

/** Whole-message attributes, for a price with no vehicle mention anywhere. */
function attributesFromLooseText(text: string): Partial<Record<AttributeKey, ResolvedAttribute>> {
  const attributes: Partial<Record<AttributeKey, ResolvedAttribute>> = {};
  absorb(attributes, statedIn(text), "class-word");
  return attributes;
}

/**
 * The verdict for a whole reply.
 *
 * A reply naming our vehicle AND another one is a `match` overall - the agent's
 * job is then to quote the right row, not to walk away. `mismatch` only when
 * every vehicle named is wrong, `unknown` when nothing can be pinned down.
 */
export function judgeReply(text: string, declared: DeclaredVehicle): VehicleJudgement {
  const vehicles = identifyVehicles(text);
  if (vehicles.length === 0) {
    const identity: VehicleIdentity = {
      label: "the vehicle",
      attributes: attributesFromLooseText(text),
      index: 0,
    };
    return judgeVehicle(identity, declared);
  }
  const judged = vehicles.map((v) => judgeVehicle(v, declared));
  return (
    judged.find((j) => j.verdict === "match") ??
    judged.find((j) => j.verdict === "unknown") ??
    judged[0]
  );
}
