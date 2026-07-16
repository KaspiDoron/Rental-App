// Pure edge-condition evaluator for the digraph engine.
//
// GraphCondition is a SUPERSET of branching.Condition: every legacy kind
// evaluates with byte-for-byte identical semantics (GraphFacts extends the
// legacy DecisionContext shape), and the graph-only kinds read the new
// negotiation-state facts. Typed predicates only - a malformed owner edit can
// never execute code or crash the loop; it just evaluates false.

import { evalCondition as evalLegacy, type Condition, type DecisionContext } from "../branching";
import type { GraphCondition, GraphFacts } from "./types";

const LEGACY_KINDS = new Set([
  "always",
  "sessionClosed",
  "shopAskedQuestion",
  "shopSentVehiclePhoto",
  "hasUsablePrice",
  "verified",
  "hasClarifyMessage",
  "matchesSpecNotFalse",
  "priceAtOrBelowFloor",
  "targetIsRealSaving",
  "rivalCheaper",
  "counterBelow",
  "counterAtLeast",
  "not",
  "all",
  "any",
]);

export function evalGraphCondition(cond: GraphCondition, facts: GraphFacts): boolean {
  try {
    switch (cond.kind) {
      case "phaseIs":
        return facts.phase === cond.phase;
      case "fieldKnown": {
        const known =
          cond.field === "price"
            ? facts.priceKnown
            : cond.field === "deposit"
            ? facts.depositKnown
            : facts.fulfillmentKnown;
        return known === cond.value;
      }
      case "depositPassportOnly":
        return facts.depositPassportOnly;
      case "cashAlternativeAskedAlready":
        return facts.cashAlternativeAsked;
      case "firmCountAtLeast":
        return facts.firmCount >= cond.min;
      case "roundsBelow":
        return facts.rounds < (cond.max ?? facts.maxRounds);
      case "toneDegraded":
        return facts.toneDegraded;
      case "dealComplete":
        return facts.dealComplete === cond.value;
      case "pickupOffered":
        return facts.pickupOffered;
      case "pickupConsentGiven":
        return facts.pickupConsent;
      case "hasMedia":
        return cond.media === "image"
          ? facts.hasImage
          : cond.media === "audio"
          ? facts.hasAudio
          : facts.hasImage || facts.hasAudio;
      case "mediaCoherent":
        return facts.mediaCoherent === cond.value;
      case "eventIs":
        return facts.event === cond.event;
      case "priceFarAboveFloor":
        return facts.priceFarAboveFloor;
      case "shopDeclinedDeal":
        return facts.shopDeclined;
      case "nodeRanBelow":
        return (facts.nodeRuns[cond.nodeId] ?? 0) < cond.max;
      case "notG":
        return !evalGraphCondition(cond.of, facts);
      case "allG":
        return cond.of.every((c) => evalGraphCondition(c, facts));
      case "anyG":
        return cond.of.some((c) => evalGraphCondition(c, facts));
      default: {
        // Legacy branching kinds - including nested not/all/any trees that may
        // themselves contain graph-only kinds. Walk composites here so mixed
        // trees evaluate correctly; pure-legacy leaves delegate to the
        // original evaluator (parity guaranteed).
        const k = (cond as { kind?: string }).kind ?? "";
        if (k === "not") {
          return !evalGraphCondition((cond as { of: GraphCondition }).of, facts);
        }
        if (k === "all") {
          return (cond as { of: GraphCondition[] }).of.every((c) =>
            evalGraphCondition(c, facts)
          );
        }
        if (k === "any") {
          return (cond as { of: GraphCondition[] }).of.some((c) =>
            evalGraphCondition(c, facts)
          );
        }
        if (LEGACY_KINDS.has(k)) return evalLegacy(cond as Condition, facts);
        return false; // unknown kind (future/typo) - never crash, never match
      }
    }
  } catch {
    return false;
  }
}

/**
 * Lift a legacy DecisionContext into GraphFacts, defaulting every graph-only
 * fact to a value that keeps the legacy edges behaving identically (no media,
 * coherent, deal incomplete, no pickup). The `graph` overrides layer the
 * negotiation-state facts on top. Used by the engine's fact builder and the
 * parity tests.
 */
export function factsFromLegacy(
  ctx: DecisionContext,
  graph?: Partial<GraphFacts>
): GraphFacts {
  return {
    ...ctx,
    event: "inbound-text",
    phase: "opening",
    priceKnown: ctx.hasUsablePrice,
    priceFarAboveFloor: false,
    shopDeclined: false,
    depositKnown: false,
    fulfillmentKnown: false,
    depositPassportOnly: false,
    cashAlternativeAsked: false,
    firmCount: 0,
    rounds: ctx.counts.bargain,
    maxRounds: 3,
    toneDegraded: false,
    dealComplete: false,
    pickupOffered: false,
    pickupConsent: false,
    hasImage: false,
    hasAudio: false,
    mediaCoherent: true,
    nodeRuns: {},
    ...graph,
  };
}

// ---- plain-language explanations ---------------------------------------------
//
// Turns a condition tree + the live facts into the short human reason the
// Studio shows on the Director's ladder ("skipped - the shop already said
// last price"). Pure and client-safe; unknown kinds degrade to their label.

function leafText(cond: GraphCondition): string {
  const c = cond as Record<string, unknown> & { kind: string };
  switch (c.kind) {
    case "always":
      return "always";
    case "hasUsablePrice":
      return c.value === false ? "no usable price yet" : "we have a usable price";
    case "fieldKnown":
      return `the ${c.field} is ${c.value === false ? "still unknown" : "known"}`;
    case "dealComplete":
      return c.value === false
        ? "the deal is not complete yet"
        : "price + deposit + fulfillment are all known";
    case "firmCountAtLeast":
      return `the shop said last price / cannot lower${Number(c.min) > 1 ? ` ${c.min}+ times` : ""}`;
    case "roundsBelow":
      return `we still have bargain rounds left${c.max != null ? ` (under ${c.max})` : ""}`;
    case "depositPassportOnly":
      return "the deposit is passport-only";
    case "cashAlternativeAskedAlready":
      return "we already asked for a cash deposit instead";
    case "toneDegraded":
      return "the shop sounds annoyed";
    case "priceAtOrBelowFloor":
      return c.value === false
        ? "the price is still above the market floor"
        : "the price is already at/below the market floor";
    case "targetIsRealSaving":
      return c.value === false ? "a lower ask would not save real money" : "a lower ask saves real money";
    case "rivalCheaper":
      return "another shop in this session offered less";
    case "priceFarAboveFloor":
      return "the quote is still far above the market floor";
    case "shopDeclinedDeal":
      return "the shop walked away from the deal";
    case "shopAskedQuestion":
      return "the shop asked us a question";
    case "shopSentVehiclePhoto":
      return "the shop sent a vehicle photo";
    case "hasClarifyMessage":
      return "something needs clarifying";
    case "matchesSpecNotFalse":
      return "the offer is for the right vehicle";
    case "sessionClosed":
      return "the search session is closed";
    case "pickupOffered":
      return "the shop offered to pick the traveller up";
    case "pickupConsentGiven":
      return "the traveller approved sharing their location";
    case "hasMedia":
      return `the message carried ${c.media === "any" ? "media" : c.media}`;
    case "mediaCoherent":
      return c.value === false ? "the media reading looks inconsistent" : "the media reading is coherent";
    case "eventIs":
      return `this is a ${c.event} event`;
    case "phaseIs":
      return `the thread is in the "${c.phase}" phase`;
    case "nodeRanBelow":
      return `"${c.nodeId}" ran fewer than ${c.max} times`;
    case "counterBelow":
      return `${c.counter} used fewer than ${c.max} times`;
    case "counterAtLeast":
      return `${c.counter} used at least ${c.min} times`;
    default: {
      const v = CONDITION_VOCABULARY.find((x) => x.kind === c.kind);
      return v?.label ?? String(c.kind);
    }
  }
}

/**
 * Render a condition tree as one plain-language guard sentence (no facts
 * needed) - the static "when: ..." line under each ladder rung in the Studio.
 */
export function describeConditionText(cond: GraphCondition): string {
  const c = cond as Record<string, unknown> & { kind: string; of?: GraphCondition | GraphCondition[] };
  const kids = Array.isArray(c.of) ? (c.of as GraphCondition[]) : undefined;
  const kid = !Array.isArray(c.of) ? (c.of as GraphCondition | undefined) : undefined;
  if ((c.kind === "notG" || c.kind === "not") && kid) return `NOT (${describeConditionText(kid)})`;
  if ((c.kind === "allG" || c.kind === "all") && kids)
    return kids.map((k) => describeConditionText(k)).join(" AND ");
  if ((c.kind === "anyG" || c.kind === "any") && kids)
    return kids.map((k) => describeConditionText(k)).join(" OR ");
  return leafText(cond);
}

/**
 * Evaluate a condition AND explain the outcome in one plain sentence. On a
 * pass, `why` states what held; on a fail, `why` names the FIRST blocker -
 * exactly what a non-technical owner needs to read on a skipped ladder rung.
 */
export function explainCondition(
  cond: GraphCondition,
  facts: GraphFacts
): { pass: boolean; why: string } {
  const c = cond as Record<string, unknown> & { kind: string; of?: GraphCondition | GraphCondition[] };
  const kids = Array.isArray(c.of) ? (c.of as GraphCondition[]) : undefined;
  const kid = !Array.isArray(c.of) ? (c.of as GraphCondition | undefined) : undefined;

  if ((c.kind === "notG" || c.kind === "not") && kid) {
    const inner = explainCondition(kid, facts);
    return inner.pass
      ? { pass: false, why: `blocked: ${inner.why}` }
      : { pass: true, why: `ok: not (${leafText(kid)})` };
  }
  if ((c.kind === "allG" || c.kind === "all") && kids) {
    for (const k of kids) {
      const r = explainCondition(k, facts);
      if (!r.pass) return { pass: false, why: r.why };
    }
    return { pass: true, why: kids.map((k) => leafText(k)).join(" + ") };
  }
  if ((c.kind === "anyG" || c.kind === "any") && kids) {
    for (const k of kids) {
      const r = explainCondition(k, facts);
      if (r.pass) return { pass: true, why: r.why };
    }
    return {
      pass: false,
      why: `none of: ${kids.map((k) => leafText(k)).join(" / ")}`,
    };
  }
  const pass = evalGraphCondition(cond, facts);
  const text = leafText(cond);
  return pass ? { pass: true, why: text } : { pass: false, why: `not true: ${text}` };
}

/** Every condition kind the Studio's edge builder offers, with its params. */
export const CONDITION_VOCABULARY: {
  kind: string;
  label: string;
  params?: { name: string; type: "boolean" | "number" | "string" | "enum"; options?: string[] }[];
}[] = [
  { kind: "always", label: "always" },
  { kind: "sessionClosed", label: "the search session is closed" },
  { kind: "shopAskedQuestion", label: "the shop asked us a question" },
  { kind: "shopSentVehiclePhoto", label: "the shop sent a vehicle photo" },
  { kind: "hasUsablePrice", label: "we have a usable price", params: [{ name: "value", type: "boolean" }] },
  { kind: "verified", label: "the price is fully verified", params: [{ name: "value", type: "boolean" }] },
  { kind: "hasClarifyMessage", label: "the extractor drafted a clarify question" },
  { kind: "matchesSpecNotFalse", label: "the offer is not for the wrong vehicle" },
  { kind: "priceAtOrBelowFloor", label: "the price is at/below the market floor", params: [{ name: "value", type: "boolean" }] },
  { kind: "targetIsRealSaving", label: "our target is a real saving", params: [{ name: "value", type: "boolean" }] },
  { kind: "rivalCheaper", label: "a rival shop offered less" },
  { kind: "priceFarAboveFloor", label: "quote far above the floor (>25%)" },
  { kind: "shopDeclinedDeal", label: "the shop walked away" },
  { kind: "counterBelow", label: "legacy counter below", params: [{ name: "counter", type: "enum", options: ["clarify", "bargain", "answer", "close"] }, { name: "max", type: "number" }] },
  { kind: "counterAtLeast", label: "legacy counter at least", params: [{ name: "counter", type: "enum", options: ["clarify", "bargain", "answer", "close"] }, { name: "min", type: "number" }] },
  { kind: "phaseIs", label: "thread phase is", params: [{ name: "phase", type: "enum", options: ["opening", "awaiting_price", "negotiating", "collecting_terms", "complete", "presented", "closing", "closed", "dead"] }] },
  { kind: "fieldKnown", label: "deal field is known", params: [{ name: "field", type: "enum", options: ["price", "deposit", "fulfillment"] }, { name: "value", type: "boolean" }] },
  { kind: "depositPassportOnly", label: "the deposit is passport-only" },
  { kind: "cashAlternativeAskedAlready", label: "we already asked for a cash deposit instead" },
  { kind: "firmCountAtLeast", label: "the shop held firm at least N times", params: [{ name: "min", type: "number" }] },
  { kind: "roundsBelow", label: "bargain rounds below (empty = settings max)", params: [{ name: "max", type: "number" }] },
  { kind: "toneDegraded", label: "the shop sounds annoyed" },
  { kind: "dealComplete", label: "price + deposit + fulfillment all known", params: [{ name: "value", type: "boolean" }] },
  { kind: "pickupOffered", label: "the shop offered to pick the traveller up" },
  { kind: "pickupConsentGiven", label: "the traveller approved sharing their location" },
  { kind: "hasMedia", label: "the message carried media", params: [{ name: "media", type: "enum", options: ["image", "audio", "any"] }] },
  { kind: "mediaCoherent", label: "media reading is coherent with the thread", params: [{ name: "value", type: "boolean" }] },
  { kind: "eventIs", label: "the event is", params: [{ name: "event", type: "enum", options: ["inbound-text", "inbound-image", "inbound-audio", "tick", "user-consent-pickup", "user-close-deal", "session-closed"] }] },
  { kind: "nodeRanBelow", label: "a node ran fewer than N times", params: [{ name: "nodeId", type: "string" }, { name: "max", type: "number" }] },
];
