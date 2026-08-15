// Pure drain policy for an already-CLAIMED outbox row.
//
// HOW A ROW IS CLAIMED (read this before reasoning about re-park safety - the
// comment that used to sit here described the OLD mechanism and anyone starting
// from it starts from a false model of what a lost re-park costs):
//
//   drainOutbox claims a due row by LEASE - an atomic conditional update that
//   pushes `not_before` past now and stamps `meta.claimedAt` (wa/outbox-
//   lifecycle). The row NEVER leaves the table. Two drainers serialize on the
//   row lock and the loser matches nothing; a drainer that dies simply lets the
//   lease lapse and the row is due again.
//
// It was a delete-with-return once, and that is where this module's rule comes
// from: with the row gone, a non-terminal reject (daily cap, circuit breaker)
// that returned a bare {allow:false} without re-queuing deleted the message
// forever - "sent a few then the rest vanished". Under the lease the same
// mistake is survivable (the lease lapses and the row comes back minutes
// later), but it is still a stall nobody asked for, so the rule stands:
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

/**
 * A MESSAGE THAT IS TOO OLD TO SEND.
 *
 * The drain's only test was `not_before <= now`, which is a floor and not a
 * ceiling: a row overdue by three days passes it exactly as well as a row
 * overdue by three seconds. That was survivable while nothing was draining
 * automatically, because the queue only moved when a human opened the app.
 * The moment a scheduler starts calling the drain every minute it stops being
 * survivable - a stalled backlog gets sent, in full, to real shops.
 *
 * And the freshness gate does not catch these. `NEVER_STALE` exempts rfq /
 * custom / human-manual precisely because a cold introduction has no thread to
 * be out of date with, so an ancient "do you have a scooter for tomorrow?" is
 * judged perfectly fresh and goes out. Tomorrow was three days ago.
 *
 * Six hours: long enough that no legitimate pacing hold (the batch deadline
 * clamps to the same evening) is ever caught by it, short enough that nothing
 * sent is answering a question the traveller has forgotten asking.
 *
 * AGE IS MEASURED FROM `created_at`, AND MEASURING IT FROM `not_before` MADE
 * THE CEILING TOOTHLESS AGAINST EXACTLY THE BACKLOG IT DESCRIBES.
 *
 * `not_before` is not the message's age - it is its NEXT attempt. Every re-park
 * path rewrites it to `now + delay`: the over-budget smoothing, the lost-claim
 * penalty, the transient bounce, the duplicate hold. So a row that keeps losing
 * a claim was re-stamped young on every single pass and could never age out,
 * while a row parked once and left alone aged normally. The ceiling caught the
 * healthy rows and spared the stuck ones - the precise inverse of its purpose.
 *
 * `created_at` never moves, so "this answer is six hours out of date" is
 * finally the question being asked.
 *
 * ...MINUS THE WAIT THE ROW WAS DELIBERATELY GIVEN. A cold introduction parked
 * at 22:00 for the shop's 09:00 opening is ELEVEN HOURS old the first second it
 * becomes eligible, and the app has already promised the traveller in writing
 * that it "goes out tomorrow morning automatically". Binning it on arrival
 * would be a new lie, not a fix. So the planned wait is subtracted:
 *
 *     age = now - created_at - (firstDueAt - created_at) = now - firstDueAt
 *
 * where `firstDueAt` is stamped by the drain the first time the row is DUE and
 * still does not go out. A row serving its original schedule has no stamp and
 * keeps the old not_before reading exactly; a row bouncing around the queue has
 * one, and from then on every re-park is charged against it.
 */
export const OUTBOX_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface OutboxAge {
  /** wa_outbox.created_at, when the database has the column. */
  createdAt?: string | null;
  /** meta.firstDueAt - epoch ms of the first drain pass that did not send. */
  firstDueAt?: number | null;
  notBefore: string;
}

export function outboxExpired(row: OutboxAge, nowMs: number): boolean {
  const firstDue = Number(row.firstDueAt);
  if (!Number.isFinite(firstDue)) {
    // NEVER RE-PARKED. Either it is about to send, or it is serving the long
    // hold the guard deliberately gave it. Keep the pre-existing reading, which
    // for both of those is ~0 - and which is also the only reading available on
    // a database whose wa_outbox predates `created_at`.
    const due = Date.parse(row.notBefore);
    if (!Number.isFinite(due)) return false;
    return nowMs - due > OUTBOX_MAX_AGE_MS;
  }
  const born = row.createdAt ? Date.parse(row.createdAt) : NaN;
  // Whichever is LATER: a row cannot be older than it is, and it cannot be
  // charged for a wait it was told to serve.
  const from = Number.isFinite(born) ? Math.max(born, firstDue) : firstDue;
  return nowMs - from > OUTBOX_MAX_AGE_MS;
}
