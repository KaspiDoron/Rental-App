// A DRAFT IS A PROMISE MADE AT TIME T AND KEPT AT TIME T+delta.
//
// Ko Tao, 31 July. At ~12:23 the engine composed "That's a bit high for me
// since I'm renting for 3 days, can u give me a friendly better daily rate?".
// At 12:38 the shop said something that changed everything. At 12:39 we sent
// the sentence anyway, and at 12:43 we sent a second one agreeing a price. Both
// were correct when they were written and wrong when they were sent.
//
// Nothing in the send path could have stopped them. `drainOutbox` re-validates
// exactly three things before a parked row goes out - the anti-ban guard, the
// cancellation tombstone, and the atomic pacing claim - and not one of them
// reads the conversation. The semantic rails (spte/rails.ts) run ONCE, at
// composition, and are never run again. So the entire question "is this still
// true?" had no home.
//
// This module is that home, and it is deliberately pure: the drain has enough
// failure modes without a new one that needs a database to decide.
//
// The rule, stated once: A DRAFT COMPOSED AGAINST INBOUND N IS NEVER SENT
// AFTER INBOUND N+1 EXISTS.

/** What the thread looked like at the moment a draft was written. */
export interface ComposedAgainst {
  /** Provider id of the inbound this draft answers. The primary key of "when". */
  inboundId?: string;
  /** ISO time of that inbound - the fallback when no id was available. */
  inboundAt?: string;
  /** The shop's quote we were arguing with. */
  quotePerDay?: number;
  /** Stock as the engine understood it when it chose this move. */
  stockState?: "in-stock" | "out-of-stock" | "unknown";
  /** The move being played, so a price move can be held to a stricter test. */
  move?: string;
}

export type StaleReason = "newer-inbound" | "stock-flipped";

export interface FreshnessVerdict {
  stale: boolean;
  reason?: StaleReason;
  /** Human-readable, for the agent_events trace and the ops panel. */
  detail?: string;
}

const FRESH: FreshnessVerdict = { stale: false };

/**
 * Moves that argue about, or agree, a PRICE.
 *
 * These are the ones that cannot survive the shop changing its mind about
 * having a vehicle at all - which is exactly the pair that went out on Ko Tao
 * after the shop had said its piece. A `clarify` or a `farewell` is still
 * sensible in a thread that just went quiet; "that's too expensive" is not.
 */
const PRICE_MOVES = new Set([
  "bargain",
  "close",
  "closing-message",
  "farewell",
  "option-probe",
  "present",
]);

/**
 * Is this parked draft still the right thing to say?
 *
 * FAILS OPEN by design. When the caller cannot establish what the latest
 * inbound is - an unreadable table, a row parked before this shipped, a cold
 * introduction that answers nothing at all - the draft SENDS. Dropping a
 * correct message because a read blipped would trade one silent failure for
 * another, and the re-trigger that follows a drop needs the same database that
 * just failed. The guard's other fail-closed paths already hold a row for
 * minutes; this one must not also be able to delete work.
 */
export function judgeFreshness(args: {
  composedAgainst?: ComposedAgainst | null;
  /** Newest inbound id known for this thread right now. */
  latestInboundId?: string | null;
  /** Newest inbound time known for this thread right now (ISO). */
  latestInboundAt?: string | null;
  /** Stock as the thread reads RIGHT NOW. */
  stockNow?: "in-stock" | "out-of-stock" | "unknown" | null;
}): FreshnessVerdict {
  const c = args.composedAgainst;
  // No fingerprint = nothing to compare = not our business. Cold introductions
  // legitimately answer no inbound, and rows parked before this shipped have no
  // stamp; neither may be dropped.
  if (!c || (!c.inboundId && !c.inboundAt)) return FRESH;

  // 1) A NEWER INBOUND EXISTS. The strongest and simplest signal: the shop has
  //    spoken since we wrote this, so whatever we wrote was an answer to an
  //    older question. Identity first - ids are exact.
  if (c.inboundId && args.latestInboundId && args.latestInboundId !== c.inboundId) {
    return {
      stale: true,
      reason: "newer-inbound",
      detail: `composed against inbound ${c.inboundId}, but ${args.latestInboundId} has since arrived`,
    };
  }
  // ...then time, for the ids we never had. Strictly greater: equal timestamps
  // are the same message seen twice, not a new one.
  if (!c.inboundId && c.inboundAt && args.latestInboundAt) {
    const composed = Date.parse(c.inboundAt);
    const latest = Date.parse(args.latestInboundAt);
    if (Number.isFinite(composed) && Number.isFinite(latest) && latest > composed) {
      return {
        stale: true,
        reason: "newer-inbound",
        detail: `composed against the ${c.inboundAt} inbound, but a newer one arrived at ${args.latestInboundAt}`,
      };
    }
  }

  // 2) THE SHOP RAN OUT while this sat in the queue. Narrower than rule 1 and
  //    it catches what rule 1 cannot: a stock state that changed through a
  //    re-derivation rather than a new message. Only price moves care - and
  //    only the transition INTO out-of-stock, because a shop that restocked is
  //    a shop we can still talk prices with.
  if (
    args.stockNow === "out-of-stock" &&
    c.stockState !== "out-of-stock" &&
    c.move &&
    PRICE_MOVES.has(c.move)
  ) {
    return {
      stale: true,
      reason: "stock-flipped",
      detail: `a ${c.move} composed while the shop had stock, and it no longer does`,
    };
  }

  return FRESH;
}
