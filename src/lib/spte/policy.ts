// SPTE policy rails - the DETERMINISTIC, 0-token replacement for the graph's
// edge selection. This is the "if/else for SAFETY, not for STRATEGY" boundary:
// code computes which moves are LEGAL this turn; the single-pass LLM chooses
// freely among them and writes the message. Decision trees never dictate WHAT
// to say - only what is FORBIDDEN.

import type { MoveKind, TurnContext, TurnArtifact } from "./types";
import { menuUnresolved } from "../offer-options";
import { alreadyAsked, unaskedObligations, type ThreadLedger } from "../thread/ledger";
import type { ClaimSubject } from "../thread/claims";
import { passportOnlyDeposit, counterAlreadyMade } from "../negotiation/deposit-counter";

/**
 * Compute the legal move set for this turn from verified facts. Ordered by the
 * deterministic ladder priority (first = the fallback the coercion picks), so a
 * missing/invalid LLM choice degrades to a safe, sensible move.
 */
export function legalMovesFor(ctx: TurnContext): MoveKind[] {
  const v = ctx.inbound.verified;
  const d = ctx.thread.digest;
  const moves: MoveKind[] = [];

  // OUT OF STOCK OUTRANKS A DECLINE, and this order is the whole point.
  //
  // These two branches overlap constantly: a shop saying "sorry, I don't have
  // any bikes" reads as BOTH - it is a refusal in surface form and an
  // inventory fact in substance. Whichever branch runs first decides the
  // thread's fate, and `declined` used to run first, so a temporary,
  // completely normal stock-out was filed as a rejection and answered with a
  // goodbye. That is the Ko Tao 12:38 message: the shop had quoted 180 a
  // minute earlier, misread our "free" as a request for a free motorbike,
  // said it had none - and got farewelled by an agent that then agreed to the
  // price it had already been given.
  //
  // A decline ends a negotiation. A stock-out pauses one and gives us a
  // question worth asking. When a message can be read as either, it is the
  // one that keeps the thread alive.
  if (v.shopUnavailable) {
    if (!alreadyAskedStock(ctx)) moves.push("restock-probe");
    moves.push("silent");
    return dedupe(moves);
  }

  // Terminal / silence conditions (highest precedence after stock).
  if (v.declined) {
    // First decline owes exactly ONE warm goodbye, then silence (the B7 rule,
    // now structural): a close is legal while we have not closed yet.
    if ((d.round ?? 0) >= 0 && !hasClosed(ctx)) moves.push("farewell");
    moves.push("silent");
    return dedupe(moves);
  }
  // TERMINAL ONLY ON A REAL MISMATCH. This branch returns early and erases every
  // other move, so it must fire only when the shop POSITIVELY named a different
  // vehicle class. It used to fire on "unclear" too, which is how a shop
  // answering "Normal scooters? Some models 200 and some new 250/day" got a
  // goodbye instead of a question.
  if (v.wrongVehicle) {
    // A SHOP THAT OFFERS SOMETHING ELSE IS NOT A SHOP THAT SAID NO.
    //
    // While a substitution choice is waiting on the traveller, this thread
    // goes SILENT rather than closing. Haggling someone else's bike, or
    // thanking a shop that is actively trying to do business, are both wrong
    // answers to "no 125 today, but I have a 150 for 220". The decision rules
    // (and the TTL that stops a stale choice holding the thread forever) live
    // in vehicle/substitution.ts.
    if (ctx.thread.digest.alternativeOffer) {
      moves.push("silent");
      return dedupe(moves);
    }
    moves.push(hasClosed(ctx) ? "silent" : "redirect-close");
    return dedupe(moves);
  }

  // (The out-of-stock branch moved ABOVE `declined` - see the note there. It
  // outranks every price move for the same reason it outranks a decline: a
  // shop that has just said it has no vehicle is not a shop to haggle with.)

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
  // ...and ONLY ONCE. The Thailand field test showed the stateless version of
  // this rule re-asking the same identity question after the shop had already
  // answered it: the gate is recomputed per message, and a direct answer that
  // names no vehicle looks "unconfirmed" forever. The durable thread state
  // (vehicleAsked, from negotiation_threads.fields.vehicleConfirmation) is the
  // ask-once fact - after one ask the engine proceeds with the assumed status.
  if (v.vehicleStatus === "needs-confirmation" && !v.vehicleAsked && !dealComplete(ctx)) {
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
  // NEVER BARGAIN AGAINST YOUR OWN FLOOR - ONE NUDGE, THEN LOCK.
  //
  // `session.lowest` has been computed since the engine shipped and read by
  // nothing that decides anything: a swarm signal and a telemetry chip. So at
  // Ko Tao, with the session's best price at 180 and THIS shop quoting 180,
  // the engine bargained by construction - `rivalCheaper` and
  // `priceFarAboveFloor` are only consulted when firmCount === 1, and at
  // firmCount 0 bargain is unconditional. We answered the cheapest shop in the
  // session with "that's a bit high for me", against a floor we had set
  // ourselves. There is no rival to leverage, because we ARE the rival.
  //
  // The owner's rule, and it is the right one: exactly ONE price move at or
  // below the session low, then switch to terms whatever happens. The nudge
  // is worth having - shops move on a first ask - but a second one is
  // bargaining with ourselves, and it is how a won deal turns into a shop that
  // stops replying.
  const lockedAtFloor = atSessionLow(ctx) && alreadyPushedAtFloor(ctx);
  if (priceKnown && roundsLeft && firmAllowsBargain && !lockedAtFloor && !dealComplete(ctx)) {
    moves.push("bargain");
  }

  // Missing qualification info -> probe. Reachable now because bargain retires
  // on firm/round-cap: this IS the mandatory INFO_DISCOVERY phase. Once we have
  // a settled price we MUST learn deposit + delivery before going quiet.
  if (!moves.includes("bargain")) {
    if (!priceKnown) moves.push("clarify");
    if (priceKnown && !depositKnown(ctx)) moves.push("deposit-probe");
    // THE PASSPORT-DEPOSIT COUNTER (negotiation/deposit-counter): the shop's
    // known terms demand the ORIGINAL passport with no cash route, and we have
    // never asked for the alternative - ONE polite counter is legal. After we
    // send it the ask-once ledger gate holds it outstanding, and once the shop
    // answers, counterAlreadyMade keeps it retired forever - a decline is
    // accepted gracefully by construction.
    if (priceKnown && depositKnown(ctx) && passportCounterDue(ctx)) moves.push("deposit-probe");
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

  // A THREAD WITH NO PRICE IS NOT A FINISHED THREAD.
  //
  // Ko Tao, A & T Rental, 12:26: "Sorry,we do already discount." No price, no
  // question, no firm, no decline, no availability cue - so `clarify` was the
  // only move pushed, and the ask-once gate removed it (we asked "price" in
  // the opener, and their reply has no price token to settle it). Empty set,
  // reflex `silent`, and 28 minutes of nothing. That thread was one nudge away
  // from a quote and the engine had no way to send it, because the only move
  // it knew was the question it had already asked.
  //
  // `momentum` is that move. It has had a template since the graph engine
  // (pass.ts) and was never made legal anywhere on the SPTE path - a whole
  // move sitting unreachable. It is not the question again; it is a light
  // re-opening, which is exactly what a shop that answered vaguely needs.
  //
  // Once only, and only while the thing we came for is still missing.
  if (gated.length === 0 && !priceKnown && !alreadyNudged(ctx) && !v.declined) {
    gated.push("momentum");
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
  "restock-probe": "availability",
};

const EMPTY_LEDGER: ThreadLedger = { claims: [], known: [], outstanding: [], owed: [] };

/**
 * Have we already nudged this quiet thread?
 *
 * A nudge is a re-opening, not a question, so the ask-once ledger has nothing
 * to say about it - it gates FACT questions, deliberately. The bound lives
 * here instead: our own recent messages are already in the digest, and one
 * check-in is a nudge while two is pestering.
 */
function alreadyNudged(ctx: TurnContext): boolean {
  return (ctx.thread.digest.lastOutbound ?? []).some((m) =>
    /\b(hi again|checking in|just following up|any chance on that|any update)\b/i.test(m ?? "")
  );
}

/** Have we already put the restock question, or has the shop already answered
 *  it? Either way, asking again is nagging a shop that told us it has nothing. */
function alreadyAskedStock(ctx: TurnContext): boolean {
  const ledger = ctx.thread.digest.ledger;
  if (ledger && alreadyAsked(ledger, "availability")) return true;
  if (ctx.inbound.verified.restockHint) return true; // they already said when
  return (ctx.thread.digest.lastOutbound ?? []).some((m) =>
    /\b(back in stock|available again|when.{0,20}(available|back))\b/i.test(m ?? "")
  );
}

/** One cash-deposit counter is due: original-passport-only terms, never asked. */
export function passportCounterDue(ctx: TurnContext): boolean {
  return (
    passportOnlyDeposit(ctx.thread.digest.ledger) &&
    !counterAlreadyMade(ctx.thread.digest.lastOutbound ?? []) &&
    !counterAlreadyMade(ctx.tail.filter((m) => m.dir === "out").map((m) => m.text))
  );
}

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

/**
 * Is THIS shop's live quote the cheapest thing in the whole session?
 *
 * `<=` and not `===`: `session.lowest` is computed from the stored rows, and
 * this turn's quote may be newer than the snapshot that produced it (a shop
 * that just dropped 250 -> 200 while the ledger still says 210). Whenever our
 * own number is at or under the session floor, there is nobody left to
 * leverage.
 *
 * Exported because the leverage planner needs the same answer, and two modules
 * disagreeing about who the cheapest shop is would be worse than either
 * answer.
 */
export function atSessionLow(ctx: TurnContext): boolean {
  const low = ctx.session.lowest?.pricePerDay;
  const mine = ctx.inbound.verified.pricePerDay ?? ctx.thread.digest.quotedPricePerDay;
  return typeof low === "number" && typeof mine === "number" && mine <= low;
}

/**
 * Have we already spent our one nudge at this price?
 *
 * Derived, not stored: our own last messages are already in the digest as the
 * anti-repetition memory, and a bargain always names the number it asks for.
 * So "did we already push below this quote" is a question the thread can
 * answer, with no new column and no counter to keep in sync.
 *
 * A PRICE NAMES A PRICE; A MEASUREMENT NAMES A UNIT. That is what separates
 * the two, and it has to, because a band cannot: "125cc" for a 180/day quote
 * sits squarely inside any plausible price range. So a number carrying a unit
 * is not an ask - "3 days", "125cc", "9am" - while "160" and "160/day" are.
 * The band then catches what is left.
 */
const MEASUREMENT_UNIT =
  /^\s*(cc|km|kms|kilometers?|kg|mm|cm|hp|l|lit(er|re)s?|%|days?|nights?|weeks?|months?|years?|hours?|hrs?|mins?|minutes?|people|persons?|pax|am|pm|o'clock)\b/i;

function alreadyPushedAtFloor(ctx: TurnContext): boolean {
  const quote = ctx.inbound.verified.pricePerDay ?? ctx.thread.digest.quotedPricePerDay;
  if (typeof quote !== "number" || quote <= 0) return false;
  const mine = ctx.thread.digest.lastOutbound ?? [];
  for (const msg of mine) {
    const text = String(msg);
    for (const m of text.matchAll(/\d[\d,.]*/g)) {
      if (MEASUREMENT_UNIT.test(text.slice(m.index + m[0].length))) continue;
      const n = Number(m[0].replace(/[,.](?=\d{3}\b)/g, "").replace(/,/g, ""));
      if (!Number.isFinite(n)) continue;
      // Below the quote, but not absurdly below - an ask, not a house number.
      if (n < quote && n >= quote * 0.5) return true;
    }
  }
  return false;
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
