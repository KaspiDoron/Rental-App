// SPTE policy rails - the DETERMINISTIC, 0-token replacement for the graph's
// edge selection. This is the "if/else for SAFETY, not for STRATEGY" boundary:
// code computes which moves are LEGAL this turn; the single-pass LLM chooses
// freely among them and writes the message. Decision trees never dictate WHAT
// to say - only what is FORBIDDEN.

import type { MoveKind, TurnContext, TurnArtifact } from "./types";

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
  if (v.wrongVehicle || v.outOfStock) {
    // Not the vehicle we want / not in stock -> thank + close (never silence on
    // first contact; that was the frozen-thread bug).
    moves.push(hasClosed(ctx) ? "silent" : "redirect-close");
    return dedupe(moves);
  }

  // The shop asked for our delivery location mid-session.
  if (v.askedLocation) moves.push("pickup-location");

  // A live price is the pivot: bargain-first is structural (never probe deposit/
  // delivery while a legal bargain move exists - the price-first rule).
  const priceKnown = v.found && typeof v.pricePerDay === "number";
  const roundsLeft = (d.round ?? 0) < ctx.guards.maxRounds;
  if (priceKnown && roundsLeft && !dealComplete(ctx)) {
    moves.push("bargain");
  }

  // The shop asked us something -> answer. A license ask counts even when the
  // generic question detector missed it (shops often drop the "?").
  if (v.askedQuestion || v.askedLicense || v.askedLicensePhoto) moves.push("answer");

  // Missing qualification info -> probe (only once bargaining is exhausted or
  // no price move is legal, preserving bargain-first).
  if (!moves.includes("bargain")) {
    if (!priceKnown) moves.push("clarify");
    if (priceKnown && !depositKnown(ctx)) moves.push("deposit-probe");
    if (priceKnown && !fulfillmentKnown(ctx)) moves.push("fulfillment-probe");
  }

  // A complete, priced deal -> present it to the traveller.
  if (dealComplete(ctx)) moves.push("present");

  // Nothing owed -> silence is the most human move (the graph's default).
  if (moves.length === 0) moves.push("silent");
  return dedupe(moves);
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

// ---- fact helpers (read from the digest; all deterministic) -----------------
function hasClosed(ctx: TurnContext): boolean {
  return ctx.thread.digest.facts.some((f) => /closed|goodbye|declined/i.test(f));
}
function dealComplete(ctx: TurnContext): boolean {
  return depositKnown(ctx) && fulfillmentKnown(ctx) && typeof ctx.thread.digest.quotedPricePerDay === "number";
}
function depositKnown(ctx: TurnContext): boolean {
  return ctx.thread.digest.facts.some((f) => /deposit/i.test(f));
}
function fulfillmentKnown(ctx: TurnContext): boolean {
  return ctx.thread.digest.facts.some((f) => /delivery|pickup|on-shop|in-store/i.test(f));
}
function dedupe(m: MoveKind[]): MoveKind[] {
  return Array.from(new Set(m));
}
