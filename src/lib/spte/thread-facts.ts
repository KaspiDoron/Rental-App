// THREAD-DERIVED negotiation state (pure, unit-tested). The thread history IS
// the durable state - these facts are recomputed every turn from the rows the
// engine already loads, so nothing has to persist and nothing can go stale.
//
// This is the fix for four live failures at once:
//   - firmCount: the shop said "last price" - after TWO firm refusals the engine
//     must STOP bargaining (it pushed 280 anyway).
//   - depositKnown / fulfillmentKnown: whether the shop has already told us its
//     deposit terms / delivery-vs-pickup, so the engine can run the mandatory
//     logistics close-out instead of bargaining forever.
//   - bargainRounds: how many times WE actually pushed on price - the round cap
//     that was pinned at 0 (every send was mis-stamped "reply").

/** A shop refusing to lower a price it already gave ("last price", "final",
 *  "cannot go lower"). Mirrors FIRM_RX in agents.ts - kept in sync deliberately;
 *  a decline ("no stock", "we don't have") is NOT firmness. */
export const FIRM_RX =
  /\b(last price|final price|best price( already| for you| na)?|fix(?:ed)? price|cannot (?:go )?lower|can'?t (?:go )?lower|no discount|no lower|lowest (?:price|already|na)|already (?:the )?lowest|final na|price is firm|firm price|cheapest we can|that'?s (?:the|my|our) (?:best|last|final|lowest|cheapest))\b/i;

/** The shop stated a deposit requirement (cash amount or passport). */
const DEPOSIT_RX =
  /\b(deposit|down ?payment|passport|collateral|security|hold your|as a bond|licen[cs]e as)\b/i;

/** The shop answered the logistics question (delivery vs shop pickup). */
const FULFILLMENT_RX =
  /\b(deliver|delivery|drop( it)? off|bring it|we (can|will) deliver|free delivery|pick ?up|pick it up|come to (the|our) shop|at (the|our) shop|in ?store|meet you)\b/i;

/** The stamped moves that ARE a push on price. Anything else stamped - answer,
 *  clarify, close, a probe - is not a round, whatever its wording looks like. */
const BARGAIN_KINDS = new Set(["bargain", "auto-bargain", "counter", "auto-counter"]);

/** Fallback for UNSTAMPED history only. A message reads as a push when it asks
 *  for less; a bare daily-rate mention does not, which is why this is only
 *  consulted when no stamp exists. */
const BARGAIN_TEXT_RX =
  /\b(better (rate|deal|price)|lower|discount|cheaper|can (you|u) do|even better|multi-day|per day\??$|\/day\??)\b/i;

export interface ThreadFacts {
  /** Cumulative count of shop messages asserting a firm/last price. */
  firmCount: number;
  /** The shop has told us its deposit terms. */
  depositKnown: boolean;
  /** The shop has told us delivery-vs-pickup. */
  fulfillmentKnown: boolean;
  /** How many times WE pushed on price in this thread (the round counter). */
  bargainRounds: number;
  /** Our last N outbound bodies, oldest first - the anti-repetition memory. */
  lastOutbound: string[];
}

export interface ThreadFactsInput {
  /** Every inbound (shop) message body in this thread, chronological. */
  inbound: string[];
  /** Every outbound (our) message body in this thread, chronological. */
  outbound: string[];
  /** The move stamped on each `outbound` entry, SAME ORDER, SAME LENGTH;
   *  `undefined` where the row carries no stamp. Supplying it is what stops our
   *  own `answer` template being counted as a bargain round - see the note at
   *  the derivation below. Omit it and every entry falls back to the wording,
   *  which is the pre-existing behaviour. */
  outboundKinds?: (string | undefined)[];
  /** The message that JUST arrived (may already be in `inbound`; deduped). */
  currentInbound?: string;
  /** How many prior bargains the caller counted from message kinds - the
   *  computed value is max(this, derived) so a mis-stamped history still heals. */
  priorBargainCount?: number;
}

/** Count shop messages that assert a firm price across the whole thread. */
function countFirm(msgs: string[]): number {
  return msgs.filter((m) => FIRM_RX.test(m)).length;
}

export function deriveThreadFacts(input: ThreadFactsInput): ThreadFacts {
  const inbound = [...input.inbound];
  const cur = (input.currentInbound ?? "").trim();
  // Include the just-arrived message if it is not already the last stored one.
  if (cur && inbound[inbound.length - 1]?.trim() !== cur) inbound.push(cur);

  const firmCount = countFirm(inbound);
  const depositKnown = inbound.some((m) => DEPOSIT_RX.test(m));
  const fulfillmentKnown = inbound.some((m) => FULFILLMENT_RX.test(m));

  // Round count: how many of OUR messages actually pushed on price.
  //
  // WE WERE COUNTING OUR OWN ANSWERS AS PUSHES. The regex below cannot tell a
  // bargain from a confirmation, because our own templates share its vocabulary:
  // the `answer` template renders "is 250 THB/day the best you can do for 4
  // days?" - which matches BOTH `/day` and `can you do` - and the price-board
  // read-back renders "I read 250 THB/day for the 4 days", which matches
  // `/day`. Both are stamped `auto-answer`. So a thread that opened with a
  // photo reached turn two believing round 1 was already spent: pass.ts emitted
  // "second push: DO NOT reuse the reason you already gave" when no reason had
  // been given, planLeverage demoted the duration card from 40 to 15 and
  // unlocked the later levers, and roundsLeft burned down early. The traveller
  // lost the strongest opening frame on every thread that started with a price
  // list - and `Math.max` meant the accurate stamped counter could never pull
  // it back down.
  //
  // The STAMP is the discriminator; the regex is only the fallback for history
  // written before moves were stamped. Where a kind is known we trust it; where
  // it is absent we fall back to the wording, which is what this heuristic was
  // always for.
  const kinds = input.outboundKinds;
  const derivedRounds = input.outbound.filter((m, i) => {
    const kind = kinds && i < kinds.length ? kinds[i] : undefined;
    if (kind) return BARGAIN_KINDS.has(kind);
    return BARGAIN_TEXT_RX.test(m);
  }).length;
  const bargainRounds = Math.max(input.priorBargainCount ?? 0, derivedRounds);

  return {
    firmCount,
    depositKnown,
    fulfillmentKnown,
    bargainRounds,
    lastOutbound: input.outbound.slice(-5),
  };
}
