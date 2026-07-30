// VEHICLE CONFIRMATION IS A THREAD FACT, NOT A MESSAGE FACT.
//
// The identity gate (identity.ts) judges one message in isolation, and the
// Thailand field test showed what that costs: Mangkorn answered OUR question
// about a 125cc automatic with "6 days 180 per day" - a direct answer, in
// context unambiguous - and the gate returned "unknown" forever, because the
// answer itself names no vehicle. The agent re-asked the same confirm question,
// the price never became an offers row, BEST PRICE showed a dash over a live
// ฿180 quote, and the cross-shop leverage engine (which reads rivals from the
// offers table) went blind.
//
// This module owns the missing capability: a durable per-thread confirmation
// STATE with conversational resolution. Three levels, in order of evidence:
//
//   confirmed  - the shop named the vehicle (identity gate match), OR the shop
//                answered OUR confirm question affirmatively / by restating the
//                price without contradiction. Hard evidence. Never regresses.
//   assumed    - the shop quoted a price as a DIRECT ANSWER to our spec'd
//                request and nothing contradicts the spec. Honest soft state:
//                presentable as "unverified", bargainable, still worth one
//                automatic confirm question.
//   unconfirmed- nothing ties this thread's prices to the declared vehicle yet.
//
// Pure by design (unit-testable, replayable); the DB glue lives with the
// callers (agent-loop reads/attaches, graph/state persists).

import { judgeReply, type DeclaredVehicle } from "./identity";

export type ConfirmationStatus = "confirmed" | "assumed" | "unconfirmed";

export interface VehicleConfirmationState {
  status: ConfirmationStatus;
  /** Plain-language provenance, safe for traces and the Ops console. */
  evidence: string;
  at: string; // ISO
  /** Stamped when OUR confirm question went out - the ask-once fact. */
  askedAt?: string;
}

export const UNCONFIRMED: VehicleConfirmationState = {
  status: "unconfirmed",
  evidence: "no evidence yet",
  at: new Date(0).toISOString(),
};

/**
 * Did THIS outbound text of ours ask the shop to confirm the vehicle?
 *
 * Distinguished from the RFQ (which also names the spec but asks for a PRICE):
 * a confirm ask is identity-shaped - "is it / is this / just to confirm ...".
 * Matching structure + any declared attribute term keeps it phrasing-proof
 * across the randomized template family.
 */
export function askedVehicleQuestion(
  outboundText: string | null | undefined,
  declared: DeclaredVehicle
): boolean {
  const t = (outboundText ?? "").toLowerCase();
  if (!t || !t.includes("?")) return false;
  const confirmFrame =
    /\b(is (it|this|that|the)|just to (check|confirm)|to confirm|confirm(ing)? (this|that|it)|make sure|double[- ]check)\b/i.test(
      t
    );
  if (!confirmFrame) return false;
  const attributeTerms: string[] = [];
  if (declared.displacementCc) attributeTerms.push(`${declared.displacementCc}`);
  if (declared.transmission) attributeTerms.push(declared.transmission);
  if (declared.class) attributeTerms.push(declared.class);
  attributeTerms.push("cc", "model", "version");
  return attributeTerms.some((term) => t.includes(term));
}

/**
 * Does this shop reply AFFIRM what was just asked? Deliberately small and
 * high-precision: these words answer a yes/no question; anything fuzzier goes
 * through the price-restatement path instead.
 */
export function affirms(text: string | null | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  return /\b(yes|yeah|yep|yup|sure|correct|right|exactly|of course|definitely|certainly|confirm(ed)?|that'?s right|it is)\b/.test(
    t
  );
}

export interface ConfirmationInput {
  declared: DeclaredVehicle;
  /** The shop's inbound message this turn. */
  inboundText: string;
  /** OUR most recent outbound in this thread (empty when none/unknown). */
  lastOutboundText: string;
  /** The per-message identity verdict for the price in play (null = no price). */
  messageStatus: "confirmed" | "needs-confirmation" | "wrong-vehicle" | null;
  /** A usable price was read from this reply. */
  hasPrice: boolean;
}

/**
 * One transition per inbound turn. CONFIRMED NEVER REGRESSES: a later
 * vehicle-less price update ("1100b./6days") keeps the thread confirmed - that
 * exact update went missing in the field because each message was re-judged
 * from scratch.
 */
export function resolveConfirmation(
  prev: VehicleConfirmationState | null | undefined,
  input: ConfirmationInput
): VehicleConfirmationState {
  const now = new Date().toISOString();
  const asked = askedVehicleQuestion(input.lastOutboundText, input.declared);
  // The ask-once fact survives every transition below.
  const askedAt = prev?.askedAt ?? (asked ? now : undefined);
  const keep = (s: VehicleConfirmationState): VehicleConfirmationState =>
    askedAt && !s.askedAt ? { ...s, askedAt } : s;

  // Hard evidence in THIS message outranks everything.
  if (input.messageStatus === "confirmed") {
    return keep({ status: "confirmed", evidence: "the shop named the vehicle", at: now });
  }

  if (prev?.status === "confirmed") return keep(prev);

  // A positively-different vehicle never upgrades the thread. (The per-message
  // verdict still flags that price; the thread just gains no confirmation.)
  const contradicted =
    input.messageStatus === "wrong-vehicle" ||
    judgeReply(input.inboundText, input.declared).verdict === "mismatch";
  if (contradicted) return keep(prev ?? UNCONFIRMED);

  // We asked; the shop answered. "Yes"/"definitely" confirms outright, and so
  // does restating the price without contradiction - a shop that answers "if
  // you rent 6 days it will definitely cost 180 baht per day" to "is the 180
  // for the automatic 125cc?" has answered it.
  if (asked && (affirms(input.inboundText) || input.hasPrice)) {
    return {
      status: "confirmed",
      evidence: affirms(input.inboundText)
        ? "the shop affirmed our confirm question"
        : "the shop restated the price to our confirm question without contradiction",
      at: now,
      askedAt,
    };
  }

  // A price given as a direct answer to our spec'd request: assume, honestly.
  if (input.hasPrice) {
    return keep({
      status: "assumed",
      evidence: "the shop quoted a price directly against our stated request",
      at: prev?.status === "assumed" ? prev.at : now,
    });
  }

  return keep(prev ?? UNCONFIRMED);
}
