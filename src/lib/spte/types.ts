// SPTE - Single-Pass Turn Engine (V2-4). The types for the Blackboard +
// single-pass agent that replaces the graph director/edge branching.
//
// Design (from docs/V2-BLUEPRINT.md section 4): at most ONE LLM call per
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
  // A WARM GOODBYE, and nothing else.
  //
  // It was called `close`, and the model was never told what that meant. The
  // prompt emits a bare `LEGAL MOVES: close, silent` with no glossary, so the
  // only definition available to it was the English word - which in a sales
  // conversation means CLOSE THE DEAL. On Ko Tao it did exactly that: the shop
  // said it had no bikes, `close` became legal, and the agent replied "great,
  // 180 baht per day is a good price!" to a shop that had just withdrawn.
  //
  // The name is now the definition. A move called `farewell` cannot be misread
  // as an agreement by anything that reads English, and `moveGlossary` states
  // it in the prompt anyway. `close` is still accepted on the way IN
  // (normalizeMove) because model output, stored owner corrections and golden
  // cases all predate the rename.
  | "farewell"
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
  // The shop has just told us it has nothing to rent right now ("Now I don't
  // have bike."). Not a decline and not a dead end - acknowledge it warmly and
  // ask ONE question worth asking: when does it come back?
  | "restock-probe"
  | "redirect-close" // NEW (B7): wrong-vehicle / not-offering -> thank + close
  // THE BRUSH-OFF (W4.3). "You should try asking other shops; maybe they'll
  // give you one." That is a shop ending the conversation politely, and the
  // engine had no category for it at all: dialogue acts carry ASK kinds and
  // SHARE kinds with no refusal member, and the one terminal-refusal regex
  // lists "not interested" / "good luck" / "take it there". So the turn walked
  // the whole ladder to its "no price yet" default - whose only legal moves ARE
  // rate re-asks - and coerceToLegal sent one. The shop had just told us to go
  // away and we asked it for its daily rate.
  //
  // Distinct from `farewell` (a decline we were TOLD) and from `redirect-close`
  // (they do not stock what we need) because it is neither, and the model reads
  // these tokens as English: this one is "they are done with us, thank them and
  // stop". Never a re-ask, never a price, never a second message.
  | "graceful-close"
  // THE CONFIRM-QUESTION DOCTRINE (W4.4, the owner's rule verbatim): "if they
  // are not positive about something (anything) they should ask the shop, but
  // in a way of a question." Subject-parameterized (see ConfirmSubject) so one
  // move covers deposit, price, availability, conditions and vehicle instead of
  // the single hard-coded `confirm-vehicle` that was the entire vocabulary for
  // checking a fact. Legal only while the comprehension pass reports it is not
  // sure, and only ONCE per subject - see the ledger's third state.
  | "confirm"
  | "momentum"
  | "closing-message"
  | "silent";

/**
 * The facts a confirming question may be put about. Closed, like the move
 * vocabulary it parameterizes, and mirrored by the zod enum in
 * semantic/classifiers.ts (the model may only name one of these).
 */
export type ConfirmSubject = "deposit" | "price" | "availability" | "conditions" | "vehicle";

/**
 * ONE THING THIS TURN IS NOT SURE IT READ RIGHT.
 *
 * `reading` is the fact we would otherwise have latched (and, before this,
 * always did - `depositKnown` went true on the bare word "passport" anywhere in
 * any inbound message, so a misread deposit was permanent). `question` is the
 * confirming question the model already phrased in the traveller's voice, so
 * even the LLM-down composer can send something that reads like a person.
 */
export interface Uncertainty {
  subject: ConfirmSubject;
  reading: string;
  question: string;
  /** The model's own confidence that this is genuinely worth asking about. */
  confidence: number;
}

/** Where a shop stands with us, as a person would read it (W4.3). */
export type ShopStance = "engaged" | "deflecting" | "declining" | "unclear";

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
  rivals: Array<{
    vendorId: string;
    shop: string;
    pricePerDay: number;
    currency: string;
    /**
     * PROVENANCE (owner report 5 #2). The per-day figure was DIVIDED out of a
     * package covering this many days ("500 for 3 days" -> 167) rather than
     * quoted per day. It is real arithmetic on a real number, but it is not a
     * price any shop stated for THIS rental length, so every surface that
     * repeats it has to say "works out to about" instead of "they quoted".
     */
    derivedFromDays?: number;
  }>;
  /** Priors banked from past successful deals (self-improvement loop). */
  priors?: { medianAchieved?: number; typicalDiscountPct?: number; sampleSize: number } | null;
  /** Few-shot TONE/tactic coaching (owner teaching + Ops learning + distilled
   *  winning traces). Injected into the prompt; numbers are never copied. */
  coaching?: string;
}

export interface ThreadDigest {
  facts: string[]; // <=10 durable one-liners; the compressed conversation
  quotedPricePerDay?: number;
  /**
   * A SUBSTITUTION WAITING ON THE TRAVELLER. The shop offered a different
   * vehicle that is close enough to be worth asking about, so this thread is
   * paused rather than closed until they accept or decline. See
   * vehicle/substitution.ts for the decision rules and the staleness TTL.
   */
  alternativeOffer?: import("../vehicle/substitution").AlternativeOffer | null;
  round: number;
  tone?: "friendly" | "curt" | "eager" | "reluctant";
  // Thread-derived negotiation state (src/lib/spte/thread-facts.ts). Recomputed
  // every turn from the loaded rows - never persisted, never stale.
  firmCount?: number; // shop said "last price" this many times
  depositKnown?: boolean; // the shop already told us its deposit terms
  fulfillmentKnown?: boolean; // the shop already told us delivery-vs-pickup
  /** The shop offered to BRING it - the only mode that can carry a fee. */
  deliveryOffered?: boolean;
  /** The shop said what the handover costs, or that it is free. */
  fulfillmentCostKnown?: boolean;
  /** How many handover questions we have already put (stamped moves). */
  handoverAsks?: number;
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
  /**
   * SUBJECTS WE HAVE ALREADY PUT A CONFIRMING QUESTION ABOUT.
   *
   * The ask-once ledger is subject-keyed with a BOOLEAN answered state, so it
   * has no way to say "asked, answered, and the answer was ambiguous" - which
   * made a confirming re-ask structurally impossible. This is the bound on the
   * third state: one confirming question per subject, ever. Durable, because
   * the digest is now persisted (W4.5) - before that it restarted empty every
   * turn and any "we already asked" fact was a fiction.
   */
  confirmAsked?: ConfirmSubject[];
  /**
   * THE CONFIRMING QUESTION CURRENTLY IN FLIGHT. Surfaced on the shop card as
   * "double-checking with the shop", so a traveller watching a thread pause on
   * a question can see WHY instead of watching an idle card.
   */
  awaitingConfirmation?: { subject: ConfirmSubject; question: string } | null;
  /**
   * THE PRICE WATCH HAS ALREADY BEEN ARMED FOR THIS THREAD (owner report 5 #9).
   *
   * A priced thread schedules no return of its own: a wakeup is written only
   * when the model asked to wait (clamped to 3 minutes - a pause-before-replying
   * tactic, not a re-entry) or when the turn went silent with no price. So a
   * shop that quoted 300 and fell quiet could never hear about the 200 that
   * landed twenty minutes later, because no turn ever happened in which it
   * could be said.
   *
   * One long re-entry per thread, ever, recorded here. Durable because the
   * digest is (W4.5). The bound is the whole design: without it, every
   * re-entered turn that lands silent-and-priced would arm another watch, and a
   * negotiation assistant would become a slow broadcast loop.
   */
  priceWatchArmed?: boolean;
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
  /** We ALREADY asked the confirm question in this thread (ask-once fact from
   *  the durable thread confirmation state). A second identity ask is never
   *  legal - the engine proceeds with the assumed status instead. */
  vehicleAsked?: boolean;
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
  /** THE SHOP HAS NOTHING TO RENT right now (thread/ledger stockState). A real,
   *  temporary state - the card says so and the agent asks when it returns. */
  shopUnavailable?: boolean;
  /** The shop's own words about when stock returns, when it offered them. */
  restockHint?: string;
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
  /**
   * THE PHOTO ARRIVED AND NOBODY LOOKED AT IT. Every vision provider failed - a
   * rejected key, a quota, a timeout, a safety block - so this turn has an image
   * it has never seen. Distinct from a photo that was read and carried nothing:
   * that one is answered with "which line is mine?", this one cannot be, and
   * pretending otherwise is how the app claimed to have read a board it had not.
   */
  imageUnread?: boolean;
  /** A price that came from a PHOTO rather than typed text. */
  sheetPricePerDay?: number;
  // ---- the comprehension pass (spte/comprehension.ts) -----------------------
  /**
   * THE SHOP IS GETTING RID OF US POLITELY. Read by a model over the whole
   * message, never by a phrase list - "you should try asking other shops" is
   * a brush-off in every language and matches no refusal vocabulary in any of
   * them. Terminal, like `declined`, but its own state so the card can say
   * "they passed" rather than inventing a decline the shop never made.
   */
  deflected?: boolean;
  /** The comprehension pass's stance verdict, carried for the trace + prompt. */
  stance?: ShopStance;
  /** The shop's own words behind the stance, so nothing has to be paraphrased. */
  stanceQuote?: string;
  /**
   * FACTS THIS TURN IS NOT SURE IT READ RIGHT (W4.4). Empty on a plain message.
   * Non-empty makes `confirm` a legal move - the engine asks rather than
   * latching a reading it does not trust.
   */
  uncertain?: Uncertainty[];
  /**
   * The comprehension pass could not run - no reachable provider. Distinct from
   * "it ran and found nothing": one is an outage that must degrade to the old
   * deterministic behaviour, the other is a clean read.
   */
  comprehensionDegraded?: boolean;
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
  /**
   * THE OWNER'S SLIDERS REACH THIS ENGINE, OR THEY REACH NOTHING.
   *
   * Nothing under src/lib/spte imported the policy overlay, and SPTE is the
   * PRIMARY engine (the graph engine is the failover). So every threshold the
   * owner moved in Admin -> Ops applied only to the path that usually does not
   * run: `priceFarAboveFloor` was hard-coded 1.25 here while the overlay's own
   * default is 1.08 with a comment calling 1.25 "far too soft"; `maxRounds` was
   * hard-coded 6 while the graph spec's owner-editable maxRoundsPerShop
   * defaults to 4, so the live engine allowed 50% more pushes per shop than the
   * configured policy; and bannedPhrases was enforced only in the graph engine,
   * so a phrase the owner banned still went out on every real message.
   *
   * Both numbers are OPTIONAL with the historical literal as the fallback, so a
   * caller that cannot read config (replay, the simulator, a unit test) behaves
   * exactly as before rather than silently adopting a different policy.
   */
  guards: {
    floorPerDay?: number;
    maxRounds: number;
    /** overlay.priceFarAboveFloor; falls back to the historical 1.25. */
    priceFarAboveFloor?: number;
    /** overlay.bannedPhrases - scrubbed from the finished draft by the rails. */
    bannedPhrases?: string[];
  };
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
  /** Which fact a `confirm` move is putting back to the shop. Set by the
   *  engine from the legal-move computation, never by the model - the model
   *  picks the MOVE, the policy already decided which subject is unsettled. */
  confirmSubject?: ConfirmSubject;
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
  /**
   * WHICH PROVIDER ACTUALLY ANSWERED.
   *
   * Declared here since the engine shipped and assigned by nobody, so the Ops
   * turn row fell through to its `mock/local` chip on one hundred percent of
   * turns - including every turn a real model composed. The help text then
   * explained that "'mock/local' means no live key was used", which made a
   * cosmetic omission read as a broken deployment.
   *
   * The failover chain has always known the answer (chatDetailed returns it);
   * `chat()` simply threw it away at the call site. The hand-written union
   * knew four of the nine configurable providers, which is its own way of
   * losing the truth, so it reads the real list now.
   */
  provider?: import("../ai").ProviderName;
  /**
   * WHY NO PROVIDER ANSWERED, when none did.
   *
   * Without it, "no key is configured" and "every configured key is failing"
   * are the same observation from the outside: a deterministic template, a null
   * provider, and an Ops chip reading mock/local. One is a demo deployment and
   * the other is an outage in progress, and the owner needs to tell them apart
   * at a glance - especially now that eight providers are configured.
   */
  error?: string;
  model?: string;
  reason: "reflex" | "default" | "multimodal" | "high-stakes" | "quota-overflow" | "replay";
}
