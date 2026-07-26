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

  // Round count: how many of OUR messages actually pushed on price. A bargain
  // reads as an ask to lower ("better", "lower", "discount", a "PHP/day" target,
  // "can you do"). This heals a history where sends were mis-stamped "reply".
  const derivedRounds = input.outbound.filter((m) =>
    /\b(better (rate|deal|price)|lower|discount|cheaper|can (you|u) do|even better|multi-day|per day\??$|\/day\??)\b/i.test(
      m
    )
  ).length;
  const bargainRounds = Math.max(input.priorBargainCount ?? 0, derivedRounds);

  return {
    firmCount,
    depositKnown,
    fulfillmentKnown,
    bargainRounds,
    lastOutbound: input.outbound.slice(-5),
  };
}
