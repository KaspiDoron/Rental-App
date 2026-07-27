// SPTE policy rails - the DETERMINISTIC, 0-token replacement for the graph's
// edge selection. This is the "if/else for SAFETY, not for STRATEGY" boundary:
// code computes which moves are LEGAL this turn; the single-pass LLM chooses
// freely among them and writes the message. Decision trees never dictate WHAT
// to say - only what is FORBIDDEN.

import type { MoveKind, TurnContext, TurnArtifact } from "./types";
import { menuUnresolved } from "../offer-options";
import { alreadyAsked, unaskedObligations, type ThreadLedger } from "../thread/ledger";
import type { ClaimSubject } from "../thread/claims";

/**
 * Compute the legal move set for this turn from verified facts. Ordered by the
 * deterministic ladder priority (first = the fallback the coercion picks), so a
 * missing/invalid LLM choice degrades to a safe, sensible move.
 */
export function legalMovesFor(ctx: TurnContext): MoveKind[] {
  const v = ctx.inbound.verified;
  const d = ctx.thread.digest;
  const moves: MoveKind[] = [];

  // Terminal / silence conditions first (highest precedence).
  if (v.declined) {
    // First decline owes exactly ONE warm goodbye, then silence (the B7 rule,
    // now structural): a close is legal while we have not closed yet.
    if ((d.round ?? 0) >= 0 && !hasClosed(ctx)) moves.push("close");
    moves.push("silent");
    return dedupe(moves);
  }
  // TERMINAL ONLY ON A REAL MISMATCH. This branch returns early and erases every
  // other move, so it must fire only when the shop POSITIVELY named a different
  // vehicle class. It used to fire on "unclear" too, which is how a shop
  // answering "Normal scooters? Some models 200 and some new 250/day" got a
  // goodbye instead of a question.
  if (v.wrongVehicle) {
    moves.push(hasClosed(ctx) ? "silent" : "redirect-close");
    return dedupe(moves);
  }

  // ANSWER-FIRST when the shop asked something. This MUST precede bargain in the
  // ladder: coerceToLegal and the fallback both take legal[0], so if bargain led
  // the list a question would go unanswered (the live "agent ignored 'Around
  // what time?'" bug). A question the shop asks is owed a reply before any push.
  const askedQ = v.askedQuestion || v.askedLicense || v.askedLicensePhoto;
  // Only legal when there is something VERIFIED to share. With no stay on file
  // the honest move is to answer the question without an address (the UI asks
  // the traveller for one) - never to improvise a location.
  if (v.askedLocation && ctx.share?.addressText) moves.push("pickup-location");
  if (askedQ) moves.push("answer");

  // RESOLVE THE MENU BEFORE HAGGLING IT. When the shop has offered more than one
  // tier and we still cannot tell them apart, the next useful move is to ask
  // what separates them - not to bargain a number the traveller has not chosen.
  // Ordered ahead of `bargain` because coerceToLegal and the LLM-down fallback
  // both take legal[0]. This is a fact about the DATA (menuUnresolved), never a
  // rule about the shop's wording.
  // SETTLE THE VEHICLE BEFORE THE PRICE. The strongest ordering rule in the
  // ladder, because everything downstream is worthless if the number belongs to
  // a bike the traveller cannot legally ride. This is a fact about the DATA -
  // the identity gate's status - never a rule about the shop's wording, and it
  // sits ahead of every price move because coerceToLegal and the LLM-down
  // fallback both take legal[0].
  if (v.vehicleStatus === "needs-confirmation" && !dealComplete(ctx)) {
    moves.push("confirm-vehicle");
  }

  const options = d.options ?? [];
  const menuOpen = menuUnresolved(options) || (Boolean(v.variance) && !v.found);
  if (menuOpen && !dealComplete(ctx)) moves.push("option-probe");

  // FIRM LADDER (graph parity, the two-firms-stop rule). The shop said "last
  // price" firmCount times:
  //   - >=2  -> price bargaining is OVER. Never push again.
  //   - ===1 -> one more push is allowed ONLY with real leverage (a verified
  //             cheaper rival, or a price still far above the floor).
  //   -  0   -> bargain freely (subject to the round cap).
  const firmCount = d.firmCount ?? 0;
  const rivalCheaper =
    typeof ctx.session.rivals?.[0]?.pricePerDay === "number" &&
    typeof v.pricePerDay === "number" &&
    ctx.session.rivals[0].pricePerDay < v.pricePerDay;
  const priceFarAboveFloor =
    typeof ctx.guards.floorPerDay === "number" &&
    typeof v.pricePerDay === "number" &&
    v.pricePerDay > ctx.guards.floorPerDay * 1.25;
  const firmAllowsBargain =
    firmCount >= 2 ? false : firmCount === 1 ? rivalCheaper || priceFarAboveFloor : true;

  // A live price is the pivot: bargain-first is structural (never probe deposit/
  // delivery while a legal bargain move exists), BUT the firm ladder and the
  // round cap can retire bargaining, which is exactly what unlocks the
  // logistics close-out below.
  const priceKnown = v.found && typeof v.pricePerDay === "number";
  const roundsLeft = (d.round ?? 0) < ctx.guards.maxRounds;
  if (priceKnown && roundsLeft && firmAllowsBargain && !dealComplete(ctx)) {
    moves.push("bargain");
  }

  // Missing qualification info -> probe. Reachable now because bargain retires
  // on firm/round-cap: this IS the mandatory INFO_DISCOVERY phase. Once we have
  // a settled price we MUST learn deposit + delivery before going quiet.
  if (!moves.includes("bargain")) {
    if (!priceKnown) moves.push("clarify");
    if (priceKnown && !depositKnown(ctx)) moves.push("deposit-probe");
    if (priceKnown && !fulfillmentKnown(ctx)) moves.push("fulfillment-probe");
  }

  // A complete, priced deal -> present it to the traveller.
  if (dealComplete(ctx)) moves.push("present");

  // DO NOT ASK WHAT WE HAVE ALREADY ASKED. A fact-question whose answer is still
  // outstanding is not a legal move - not discouraged in a prompt, ABSENT. This
  // is what stops "could you share your best price per day for the 4 days?" from
  // going out twice; the honest alternative is to wait, which is what falls out
  // below when nothing else is legal. Only FACT questions are gated: a bargain
  // is a push, not a question, and pushing twice is a strategy the model owns.
  const gated = withoutRepeatedAsks(ctx, moves);

  // NEVER GO QUIET OWING SOMETHING. A thread that has not established the
  // deposit or how the traveller collects the vehicle is not finished, and
  // silence used to be legal there simply because nothing was owed. An
  // obligation we have not even asked about outranks falling silent.
  //
  // ...BUT AN OBLIGATION IS NOT DUE BEFORE ITS PREREQUISITE. The ledger already
  // orders these (a deposit is a term OF a price), and `priceKnown` is the same
  // rule stated against the facts the ENGINE holds rather than the words in the
  // thread - a price read off a photo never appears as a text claim, and a
  // deposit question is just as premature either way. This is the fix for the
  // live "could you let me know your deposit?" that went out to a shop which had
  // sent nothing but an opening-hours auto-reply.
  if (gated.length === 0 && priceKnown) {
    for (const subject of unaskedObligations(ctx.thread.digest.ledger ?? EMPTY_LEDGER)) {
      if (subject === "deposit") gated.push("deposit-probe");
      if (subject === "handover") gated.push("fulfillment-probe");
    }
  }

  // Nothing owed -> silence is the most human move (the graph's default).
  if (gated.length === 0) gated.push("silent");
  return dedupe(gated);
}

/** Fact-questions, and the subject each one asks about. A move not in here is
 *  not a question and is never gated by the ledger. */
const QUESTION_SUBJECT: Partial<Record<MoveKind, ClaimSubject>> = {
  clarify: "price",
  "deposit-probe": "deposit",
  "fulfillment-probe": "handover",
};

const EMPTY_LEDGER: ThreadLedger = { claims: [], known: [], outstanding: [], owed: [] };

function withoutRepeatedAsks(ctx: TurnContext, moves: MoveKind[]): MoveKind[] {
  const ledger = ctx.thread.digest.ledger;
  if (!ledger) return moves;
  return moves.filter((m) => {
    const subject = QUESTION_SUBJECT[m];
    return !subject || !alreadyAsked(ledger, subject);
  });
}

/** Human vehicle word for the license answer ("this vehicle category"). */
function vehicleWord(ctx: TurnContext): string {
  const r = ctx.session.rfq;
  if (r.vehicleClass === "car") return "car";
  if (r.vehicleClass === "motorbike") return "motorbike";
  return "scooter";
}

/**
 * REFLEX TIER (Tier R): resolve the turn with ZERO LLM calls when the facts
 * fully determine it. Returns the move to take (optionally with the exact wire
 * text for protocol answers), or null to fall through to the single pass. This
 * is what keeps most protocol turns free - and what makes the license protocol
 * work even when every LLM provider is down.
 */
export function reflexTurn(
  ctx: TurnContext
): { move: MoveKind; reason: string; message?: string } | null {
  const legal = ctx.legalMoves;
  const v = ctx.inbound.verified;

  // LICENSE PROTOCOL (deterministic policy, owner directive):
  // - asked for a PHOTO/copy -> politely defer until the deal is agreed.
  // - asked IF we have one -> firm yes, for this vehicle category.
  // Only reflex when the message carries no price - a "license? 300/day" combo
  // still gets the full single pass (which answers both under the prompt rules).
  const priceInMessage = v.found && typeof v.pricePerDay === "number";
  if (!priceInMessage && legal.includes("answer")) {
    if (v.askedLicensePhoto) {
      return {
        move: "answer",
        reason: "license-photo ask - defer until rates agreed (policy)",
        message:
          "Sure - I'll share a photo of my license once we finalize the rate and rental details 👍 What's your best price per day?",
      };
    }
    if (v.askedLicense) {
      return {
        move: "answer",
        reason: "license ask - firm yes for this vehicle category (policy)",
        message: `Yes, I have a valid international driving license for a ${vehicleWord(ctx)}. What would your best price per day be?`,
      };
    }
  }

  // Only one legal move AND it needs no composition -> take it reflexively.
  if (legal.length === 1 && legal[0] === "silent") {
    return { move: "silent", reason: "nothing owed - silence" };
  }
  // A pure decline where the goodbye was already sent -> silence, no LLM.
  if (legal.length === 1 && legal[0] === "silent" && ctx.inbound.verified.declined) {
    return { move: "silent", reason: "already said goodbye" };
  }
  return null;
}

/**
 * Coerce an LLM move to the legal ladder (the B7 lesson generalized): never
 * trust an out-of-set choice. Falls back to the first (highest-priority) legal
 * move, exactly as the deterministic director did.
 */
export function coerceToLegal(artifact: TurnArtifact, legal: MoveKind[]): MoveKind {
  if (legal.includes(artifact.move)) return artifact.move;
  return legal[0] ?? "silent";
}

// ---- fact helpers (read from the thread-derived digest; all deterministic) ---
function hasClosed(ctx: TurnContext): boolean {
  return ctx.thread.digest.facts.some((f) => /closed|goodbye|declined/i.test(f));
}
function dealComplete(ctx: TurnContext): boolean {
  return depositKnown(ctx) && fulfillmentKnown(ctx) && typeof ctx.thread.digest.quotedPricePerDay === "number";
}
// deposit/fulfillment now come from thread-facts (digest.depositKnown /
// .fulfillmentKnown), computed from the real message history. The old `facts`
// scan was permanently false (facts was always []), which is why the logistics
// close-out never triggered. Keep the facts scan as a belt-and-braces OR.
function depositKnown(ctx: TurnContext): boolean {
  return (
    ctx.thread.digest.depositKnown === true ||
    ctx.thread.digest.facts.some((f) => /deposit/i.test(f))
  );
}
function fulfillmentKnown(ctx: TurnContext): boolean {
  return (
    ctx.thread.digest.fulfillmentKnown === true ||
    ctx.thread.digest.facts.some((f) => /delivery|pickup|on-shop|in-store/i.test(f))
  );
}
function dedupe(m: MoveKind[]): MoveKind[] {
  return Array.from(new Set(m));
}
