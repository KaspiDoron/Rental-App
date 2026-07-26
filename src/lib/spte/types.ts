// SPTE - Single-Pass Turn Engine (V2-4). The types for the Blackboard +
// single-pass agent that replaces the graph director/edge branching.
//
// Design (from V2-BLUEPRINT.md section 4): at most ONE LLM call per
// compositional turn, ZERO for reflex turns. Numbers never originate in the LLM
// (deterministic price-extract seeds them; post-rails guards verify them). The
// move vocabulary is closed (safety keys on it); the strategy is open (the LLM
// picks freely among LEGAL moves and writes the message).

import type { StructuredRFQ } from "../types";

/** The closed move vocabulary. Every deterministic guard keys on these (the
 *  D-F1 invariant), which is why strategy is free but the vocabulary is not. */
export type MoveKind =
  | "bargain"
  | "answer"
  | "clarify"
  | "present"
  | "close"
  | "deposit-probe"
  | "fulfillment-probe"
  | "pickup-location"
  | "redirect-close" // NEW (B7): wrong-vehicle / not-offering -> thank + close
  | "momentum"
  | "closing-message"
  | "silent";

export type LeverageKind = "rival" | "benchmark" | "duration-volume" | "condition";

export interface SessionSnapshot {
  sessionId: string;
  rfq: StructuredRFQ;
  currency: string;
  /** grounded=true only; an ungrounded number never reaches a prompt (F5). */
  benchmark: {
    pricePerDay: number;
    currency: string;
    sourceUrl: string;
    grounded: true;
  } | null;
  lowest: { vendorId: string; shop: string; pricePerDay: number } | null;
  rivals: Array<{ vendorId: string; shop: string; pricePerDay: number; currency: string }>;
  /** Priors banked from past successful deals (self-improvement loop). */
  priors?: { medianAchieved?: number; typicalDiscountPct?: number; sampleSize: number } | null;
  /** Few-shot TONE/tactic coaching (owner teaching + Ops learning + distilled
   *  winning traces). Injected into the prompt; numbers are never copied. */
  coaching?: string;
}

export interface ThreadDigest {
  facts: string[]; // <=10 durable one-liners; the compressed conversation
  quotedPricePerDay?: number;
  round: number;
  tone?: "friendly" | "curt" | "eager" | "reluctant";
  // Thread-derived negotiation state (src/lib/spte/thread-facts.ts). Recomputed
  // every turn from the loaded rows - never persisted, never stale.
  firmCount?: number; // shop said "last price" this many times
  depositKnown?: boolean; // the shop already told us its deposit terms
  fulfillmentKnown?: boolean; // the shop already told us delivery-vs-pickup
  lastOutbound?: string[]; // our last 5 messages - the anti-repetition memory
}

export interface VerifiedExtraction {
  found: boolean;
  pricePerDay?: number;
  currency?: string;
  declined?: boolean;
  wrongVehicle?: boolean;
  outOfStock?: boolean;
  askedLocation?: boolean;
  askedQuestion?: boolean;
  /** The shop asked whether the traveller HAS a (international) license. */
  askedLicense?: boolean;
  /** The shop asked to SEE / get a photo/copy of the license. */
  askedLicensePhoto?: boolean;
  /** The shop refused to lower a price it already gave ("last price"). */
  firm?: boolean;
}

export interface TurnContext {
  session: SessionSnapshot;
  thread: {
    threadKey: string;
    vendorId: string;
    shop: string;
    digest: ThreadDigest;
  };
  tail: Array<{ dir: "in" | "out"; text: string; at: string }>;
  inbound: { text: string; verified: VerifiedExtraction };
  /** The ONLY moves the single pass may choose from (policy rails output). */
  legalMoves: MoveKind[];
  guards: { floorPerDay?: number; maxRounds: number };
  /** Event that triggered this turn - a real inbound, a wakeup, or a swarm poke. */
  event: "shop-message" | "tick" | "rival-improved";
}

/** The single pass's entire structured JSON output. */
export interface TurnArtifact {
  read: {
    intent: string;
    priceMentioned?: number;
    declined?: boolean;
    wrongVehicle?: boolean;
    askedLocation?: boolean;
  };
  think: string; // <=80 tok scratchpad - logged, never sent
  move: MoveKind; // MUST be in legalMoves (validated + coerced)
  message?: string; // the draft (absent for silent)
  counterPricePerDay?: number; // guards verify against floor/quote/rival
  leverageUsed: LeverageKind[];
  digestPatch: string[]; // <=3 new durable facts
  waitMinutes?: number;
}

export interface RailResult {
  ok: boolean;
  finalText?: string; // post guards + uniqueness + humanize-once
  rejected?: { rule: string; detail: string };
}

export interface ModelRoute {
  tier: "R" | "F" | "M";
  provider?: "groq" | "gemini" | "cerebras" | "openrouter";
  model?: string;
  reason: "reflex" | "default" | "multimodal" | "high-stakes" | "quota-overflow";
}
