// Pure drain policy for an already-CLAIMED outbox row.
//
// drainOutbox claims a due row by DELETING it (atomic delete-with-return), then
// re-runs the guard. If the guard rejects, the row is gone from the table - so
// the drain MUST decide, purely from the verdict, whether to re-insert it. The
// data-loss bug this pins: a non-terminal reject (daily cap, circuit breaker)
// that returned a bare {allow:false} WITHOUT re-queuing left the claimed row
// deleted forever - "sent a few then the rest vanished".
//
// A claimed row must be re-parked EXACTLY when the reject is neither an explicit
// re-queue (queuedUntil set) nor a deliberate terminal drop (terminal set -
// cancelled / duplicate / rfq-dedup / takeover, where re-sending would be wrong).

export interface OutboxVerdict {
  allow: boolean;
  queuedUntil?: string; // guard already re-parked the row
  terminal?: boolean; // deliberately dropped for good
}

export function needsRepark(verdict: OutboxVerdict): boolean {
  if (verdict.allow) return false; // it is being sent - not a reject at all
  if (verdict.queuedUntil) return false; // the guard already re-queued it
  if (verdict.terminal) return false; // deliberately dropped (must NOT resurrect)
  return true; // non-terminal reject that did not re-queue -> re-park or lose it
}

/**
 * Drain send priority for a due row (LOWER = sent first). An engaged shop that
 * is WAITING on our reply must never sit behind a cold-introductions batch that
 * happens to be due at the same instant - the drain budget per invocation is
 * small, so if the rfq rows go first the reply keeps getting deferred ("our
 * agents never message back"). A user-typed message beats everything; the
 * agent's reply/bargain/answer beats a fresh rfq. Same-priority rows keep
 * oldest-due-first order.
 */
export function outboxSendPriority(kind: string | null | undefined): number {
  if (kind === "human-manual" || kind === "custom") return 0; // the user's own words
  if (kind === "rfq") return 2; // cold outreach - lowest urgency
  return 1; // agent reply / answer / bargain to an engaged shop
}

/**
 * PRIORITY PROCESSING, the paid feature that was sold and never built.
 *
 * The plans have advertised faster handling for Pro and Ultra since they
 * shipped, and the drain sorted by message KIND alone - so a paying traveller's
 * reply sat behind a free user's reply that happened to be due a second
 * earlier. Not a scandal at ten users; at a thousand it is the difference
 * between the feature existing and not.
 *
 * It is a TIE-BREAK, never a queue-jump past a different kind of message. A
 * paid cold introduction still waits behind a free user's live reply, because
 * an engaged shop waiting on an answer is the more urgent thing in the system
 * whoever is paying. Money buys position among equals, not the right to make
 * someone else's conversation go cold.
 */
export function planSendPriority(plan: string | null | undefined): number {
  const p = String(plan ?? "").toLowerCase();
  if (p === "ultra") return 0;
  if (p === "pro") return 1;
  return 2;
}

/** The full comparator: kind first, then plan, then age. */
export function compareOutboxRows(
  a: { kind?: string | null; plan?: string | null; notBefore: string },
  b: { kind?: string | null; plan?: string | null; notBefore: string }
): number {
  return (
    outboxSendPriority(a.kind) - outboxSendPriority(b.kind) ||
    planSendPriority(a.plan) - planSendPriority(b.plan) ||
    a.notBefore.localeCompare(b.notBefore)
  );
}
