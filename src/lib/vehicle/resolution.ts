// THE RESOLUTION LOOP - what makes this agentic rather than a filter.
//
// A filter would drop the wrong vehicle and move on. That is not good enough:
// the shop that quoted a 110cc BeAT at ₱400 almost certainly also rents the
// 125 the traveller wants, and walking away loses a real deal. Equally, a shop
// whose vehicle we simply cannot pin down is not a shop to guess about.
//
// So identity feeds a LOOP with exactly three exits, and the loop cannot be
// skipped by anything downstream:
//
//     CONFIRMED           every disqualifying attribute resolved and matching
//                         -> present it, bargain it, let them book it
//
//     NEEDS-CONFIRMATION  something disqualifying is unresolved, OR the shop
//                         quoted a different vehicle and may still have ours
//                         -> ASK. The question names the exact missing
//                            attribute. Nothing may be presented, bargained or
//                            booked from this price until the shop answers.
//
//     WRONG-VEHICLE       the shop has told us plainly it is not ours and has
//                         nothing else -> say so, close honestly
//
// The important half is the middle one. It is a real state, it is visible to
// the traveller, and it BLOCKS - `canPresent` and `canBargain` are the gates
// every surface and every outbound rail asks. An unresolved vehicle can no
// longer leak onto a card as "BEST PRICE ₱400" because there is no path from
// "needs-confirmation" to a presented offer that does not go through the shop
// answering the question.
//
// Nothing here is specific to engine size, or to two wheels. It reasons over
// whichever disqualifying attributes the traveller declared, so a car search
// missing a seat count blocks and asks in exactly the same way.

import { judgeReply, pairPricesWithVehicles, type DeclaredVehicle, type VehicleJudgement } from "./identity";
import { ATTRIBUTES, describeSpec, type AttributeKey } from "./spec";

/** "a scooter" / "an automatic scooter" - a bot is given away by this. */
function article(phrase: string): string {
  return /^[aeiou]/i.test(phrase) ? "an" : "a";
}

export type OfferStatus = "confirmed" | "needs-confirmation" | "wrong-vehicle";

export interface VehicleAssessment {
  status: OfferStatus;
  /** The judged vehicle this price belongs to. */
  judgement: VehicleJudgement;
  /** What the agent must still establish. Empty for `confirmed`. */
  missing: AttributeKey[];
  /** The question to ask, already phrased. Empty when nothing is missing. */
  question: string;
  /** One line a traveller can read on the card. */
  travellerNote: string;
  /** May this price be shown as a real, lockable deal? */
  canPresent: boolean;
  /** May the agent haggle over this price? */
  canBargain: boolean;
}

/**
 * The question to put to the shop.
 *
 * Built from the attribute definitions, so a new attribute is askable the day
 * it is added - and always ends by naming what the traveller actually needs, so
 * one reply can settle it.
 */
export function questionFor(declared: DeclaredVehicle, judgement: VehicleJudgement): string {
  const want = describeSpec(declared);
  // The shop named a vehicle that is definitely not ours: acknowledge it and
  // ask for the right one, rather than interrogating them about the wrong one.
  if (judgement.verdict === "mismatch") {
    const named = judgement.identity.model?.name ?? judgement.identity.label;
    return `Thanks - is that price for the ${named}? I need ${article(want)} ${want}. Do you have one, and what would it cost?`;
  }
  const asks = judgement.unresolved.map((k) => ATTRIBUTES[k].ask(declared[k])).filter(Boolean);
  if (asks.length === 0) return "";
  return `Quick check before we go further - ${asks.join(" And ")} I need ${article(want)} ${want}.`;
}

/** How the card explains a price it is deliberately not calling a deal. */
function noteFor(status: OfferStatus, declared: DeclaredVehicle, j: VehicleJudgement): string {
  const want = describeSpec(declared);
  if (status === "confirmed") return "";
  if (status === "wrong-vehicle") {
    const named = j.identity.model?.name ?? j.identity.label;
    return `This price is for ${named} - not the ${want} you asked for. Your agent is asking about the right one.`;
  }
  const named = j.identity.model?.name;
  return named
    ? `Confirming this is the ${want} - the ${named} comes in more than one version.`
    : `Confirming this is the ${want} before we call it a deal.`;
}

/**
 * Assess ONE price from ONE reply.
 *
 * `priceIndex` is where the amount sits in the text, which is what lets a reply
 * carrying two prices for two vehicles be assessed as two separate offers
 * instead of one cheapest number.
 */
export function assessPrice(
  text: string,
  declared: DeclaredVehicle,
  price: { pricePerDay: number; currency?: string; index?: number }
): VehicleAssessment {
  const paired = pairPricesWithVehicles(text, [price], declared)[0];
  // PRICE level, never rescued. This amount is attached to THIS vehicle; that
  // the shop also mentioned the right bike elsewhere in the sentence does not
  // make ₱400 the price of the Click 125. Conflating the two is exactly how the
  // BeAT's price became the traveller's best deal.
  return fromJudgement(paired.judgement, declared, text, false);
}

/** Assess a reply as a whole, when no single price is in question yet. */
export function assessReply(text: string, declared: DeclaredVehicle): VehicleAssessment {
  return fromJudgement(judgeReply(text, declared), declared, text, true);
}

function fromJudgement(
  judgement: VehicleJudgement,
  declared: DeclaredVehicle,
  text: string,
  /** Reply level: a wrong vehicle beside the right one is still a live thread. */
  replyLevel: boolean
): VehicleAssessment {
  let status: OfferStatus;
  if (judgement.verdict === "match") status = "confirmed";
  else if (judgement.verdict === "unknown") status = "needs-confirmation";
  else if (replyLevel) {
    // A shop that named the wrong vehicle but ALSO named ours in the same
    // breath is still workable - that is the Joh's Matics reply, where the
    // Click 125 sat in the very next clause. Only a reply with nothing of ours
    // in it is a dead end.
    const other = judgeReply(text, declared);
    status = other.verdict === "match" ? "confirmed" : "wrong-vehicle";
    if (status === "confirmed") judgement = other;
  } else {
    status = "wrong-vehicle";
  }

  const missing = status === "confirmed" ? [] : judgement.unresolved;
  return {
    status,
    judgement,
    missing,
    question: status === "confirmed" ? "" : questionFor(declared, judgement),
    travellerNote: noteFor(status, declared, judgement),
    // THE GATES. Both false for anything not confirmed - a price whose vehicle
    // is unsettled is a question, never a deal and never a thing to haggle.
    canPresent: status === "confirmed",
    canBargain: status === "confirmed",
  };
}

/**
 * Of several prices in one reply, the one that is actually the traveller's.
 *
 * This is the whole Joh's Matics failure in one function: given 400 (BeAT) and
 * 500 (Click 125), it returns the 500 - the cheaper number is not the answer
 * when it is not their vehicle.
 */
export function pickOurPrice(
  text: string,
  declared: DeclaredVehicle,
  prices: Array<{ pricePerDay: number; currency?: string; index?: number }>
): { price: number; currency?: string; assessment: VehicleAssessment } | null {
  const paired = pairPricesWithVehicles(text, prices, declared);
  const assessed = paired.map((p, i) => ({
    price: prices[i].pricePerDay,
    currency: prices[i].currency,
    assessment: fromJudgement(p.judgement, declared, text, false),
  }));
  const confirmed = assessed.filter((a) => a.assessment.status === "confirmed");
  if (confirmed.length) {
    return confirmed.reduce((best, a) => (a.price < best.price ? a : best));
  }
  const unsure = assessed.filter((a) => a.assessment.status === "needs-confirmation");
  if (unsure.length) {
    return unsure.reduce((best, a) => (a.price < best.price ? a : best));
  }
  return null;
}
