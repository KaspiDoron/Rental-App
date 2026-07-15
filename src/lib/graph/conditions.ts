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
