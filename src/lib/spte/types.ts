// SPTE - Single-Pass Turn Engine (V2-4). The types for the Blackboard +
// single-pass agent that replaces the graph director/edge branching.
//
// Design (from V2-BLUEPRINT.md section 4): at most ONE LLM call per
// compositional turn, ZERO for reflex turns. Numbers never originate in the LLM
// (deterministic price-extract seeds them; post-rails guards verify them). The
// move vocabulary is closed (safety keys on it); the strategy is open (the LLM
// picks freely among LEGAL moves and writes the message).

import type { StructuredRFQ } from "../types";
import type { VehicleOption } from "../offer-options";
import type { DialogueActs } from "../wa/dialogue-acts";

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
  // The shop offered a CHOICE ("some models 200, some new 250"). Resolve the
  // menu - what separates the tiers, and a photo of each - before haggling a
  // price the traveller has not picked yet.
  | "option-probe"
  // The price on the table cannot be tied to the vehicle the traveller
  // declared - a 110cc BeAT quoted to someone who asked for a 125, or a
  // nameplate that comes in several sizes and nobody said which. Settle the
  // vehicle before anything is haggled, presented or booked.
  | "confirm-vehicle"
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
  /** Every tier this shop has offered, accumulated across the whole thread. */
  options?: VehicleOption[];
  /**
   * WHAT IS KNOWN, WHAT WE ASKED, WHAT IS STILL OWED (src/lib/thread/ledger).
   * Derived every turn like everything else here. This is what makes "we already
   * asked that" and "this thread owes the traveller a deposit answer" facts the
   * legal-move set can act on, instead of hopes expressed in a prompt.
   */
  ledger?: import("../thread/ledger").ThreadLedger;
}

export interface VerifiedExtraction {
  found: boolean;
  pricePerDay?: number;
  currency?: string;
  declined?: boolean;
  /** The shop positively named a DIFFERENT vehicle class. Terminal. */
  wrongVehicle?: boolean;
  /**
   * The vehicle-identity gate (src/lib/vehicle). `needs-confirmation` means a
   * disqualifying attribute the traveller declared is still unresolved for the
   * price on the table - the engine may not bargain or present until it is.
   */
  vehicleStatus?: "confirmed" | "needs-confirmation" | "wrong-vehicle";
  /** The exact question to put to the shop, already phrased by the gate. */
  vehicleQuestion?: string;
  /** The shop has not said which vehicle yet. NOT terminal - we ask. */
  vehicleUnclear?: boolean;
  askedLocation?: boolean;
  askedQuestion?: boolean;
  /** WHAT THE SHOP DID this turn - shared facts, asked something, or sent an
   *  automated greeting. Derived per turn (lib/wa/dialogue-acts); this is what
   *  `askedQuestion` is computed FROM, so a bare "?" can no longer make the
   *  engine think it owes an answer. */
  acts?: DialogueActs;
  /** The shop asked whether the traveller HAS a (international) license. */
  askedLicense?: boolean;
  /** The shop asked to SEE / get a photo/copy of the license. */
  askedLicensePhoto?: boolean;
  /** The shop refused to lower a price it already gave ("last price"). */
  firm?: boolean;
  /** The tiers this reply offered, when the shop gave a CHOICE rather than a
   *  single price. Empty/absent for an ordinary one-price reply. */
  options?: VehicleOption[];
  /** The shop said the price depends on a choice, even if only one number
   *  parsed ("it depends what you choose"). */
  variance?: boolean;
  // ---- what the shop SENT, not just what it said ---------------------------
  /** This turn carried a photo. The primary engine was blind to this. */
  hadImage?: boolean;
  /** What the photo was: a price board, the vehicle itself, a document. */
  imageKind?: "vehicle" | "price_sheet" | "document" | "other";
  /** Everything the vision pass could read off the photo, in plain words. */
  imageSummary?: string;
  /** A price that came from a PHOTO rather than typed text. */
  sheetPricePerDay?: number;
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
  /** The ONE location disclosure gate (resolveShareableLocation). Composed from
   *  the server-verified stay only - client-posted coordinates never reach it.
   *  Absent addressText means we have nothing shareable, so `pickup-location`
   *  is not a legal move and the UI asks the traveller instead. */
  share?: { addressText?: string; mapsLink?: string };
  guards: { floorPerDay?: number; maxRounds: number };
  /** Event that triggered this turn - a real inbound, a wakeup, or a swarm poke. */
  event: "shop-message" | "tick" | "rival-improved";
  /** REPLAY ONLY. Skips the single LLM pass and composes from the deterministic
   *  templates, so a frozen thread yields the same move and the same bytes on
   *  every run - what makes the golden suite usable as an eval gate. The live
   *  path never sets this (the graph engine's `llmAllowed:false` equivalent). */
  deterministic?: boolean;
}

/** The single pass's entire structured JSON output. */
export interface TurnArtifact {
  read: {
    intent: string;
    priceMentioned?: number;
    declined?: boolean;
    wrongVehicle?: boolean;
  /**
   * The vehicle-identity gate (src/lib/vehicle). `needs-confirmation` means a
   * disqualifying attribute the traveller declared is still unresolved for the
   * price on the table - the engine may not bargain or present until it is.
   */
  vehicleStatus?: "confirmed" | "needs-confirmation" | "wrong-vehicle";
  /** The exact question to put to the shop, already phrased by the gate. */
  vehicleQuestion?: string;
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
  reason: "reflex" | "default" | "multimodal" | "high-stakes" | "quota-overflow" | "replay";
}
