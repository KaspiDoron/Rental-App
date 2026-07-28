// NOTE: deliberately NOT `server-only`, and the DB layer is imported lazily
// below - the slot/bucket rules above are pure and must stay unit-testable
// (same shape as anchor-recovery.ts).
import { digitsOnly } from "../phone";

// ONE TURN AT A TIME, PER THREAD.
//
// A shop sent three messages in a row (price list, deposit terms, "which model
// would you like?"). Two of them arrived as separate webhook deliveries, each
// ran a complete turn, and the traveller's agent sent TWO bargain messages to
// the same shop inside the same minute:
//
//     16:52  "Hi again! Any chance of a better daily rate for the scooter?..."
//     16:52  "thanks! Any chance you can do a bit better for 8 days?"
//
// Every existing exactly-once mechanism was doing its job and none of them
// applied. The system has atomic claims for a MESSAGE ID (wa_processed), an
// OUTBOX ROW, a WAKEUP ROW and a MESSAGE BODY (a sha256 of the text) - but
// nothing that says "this (traveller, shop) thread is mid-turn". Two different
// inbound frames legitimately win their own message claims, and two
// independently composed drafts hash to two different bodies, so the body-level
// idempotency cannot see that they are the same conversational moment.
//
// Worse, the counters that WOULD have stopped the second draft - rounds so far,
// bargains already sent, the ledger's outstanding asks - are all derived from
// the outbound row, and that row is written only AFTER the network send. While
// turn A is composing, turn B reads a thread state identical to A's and reaches
// the same conclusion. Every read is correct; the reads are just concurrent.
//
// So the missing primitive is a per-thread lock. On Cloud Run no in-memory lock
// works (N instances), so it is a DB conditional insert - and `wa_send_claims`
// already is exactly that, which is why this needs no migration and no new
// table. Its GC already sweeps non-`msg:` slots.

/** A full compose is bounded by the turn deadline (~45s), so a minute of
 *  exclusivity covers one turn without stranding the next. */
export const TURN_WINDOW_SEC = 60;

/** The bucket a moment falls into. Same shape as the pacing gap buckets. */
export function turnBucket(nowMs: number, windowSec: number = TURN_WINDOW_SEC): number {
  return Math.floor(nowMs / (Math.max(1, windowSec) * 1000));
}

/** The slot a (thread, bucket) pair occupies. Deliberately NOT prefixed `msg:`
 *  so the existing 2h claim GC reclaims it. */
export function threadTurnSlot(toDigits: string, bucket: number): string {
  return `turn:${digitsOnly(toDigits)}:${bucket}`;
}

export type TurnClaim = "won" | "lost" | "error";

/**
 * Claim the right to run THIS thread's turn now.
 *
 * Straddle-proof in the same way the pacing gap is: winning the current bucket
 * also requires the PREVIOUS bucket to be free, so two turns that land either
 * side of a bucket boundary cannot both proceed.
 *
 * FAILS OPEN. A missing or unreachable claim table must never silence a shop -
 * a rare duplicate is a far smaller harm than a conversation going dead, and
 * that is the same call `claimInboundStore` and `claimSendSlots` already make
 * for a pre-migration deployment.
 */
export async function claimThreadTurn(
  senderKey: string,
  toDigits: string,
  nowMs: number = Date.now()
): Promise<TurnClaim> {
  if (!senderKey || !toDigits) return "won";
  const { sbInsertClaim, sbSelectStrict } = await import("../runtime-config");
  const bucket = turnBucket(nowMs);
  const got = await sbInsertClaim("wa_send_claims", {
    sender_key: senderKey,
    slot_key: threadTurnSlot(toDigits, bucket),
  });
  if (got === "lost") return "lost";
  if (got === "error") {
    const probe = await sbSelectStrict("wa_send_claims", "select=slot_key&limit=1");
    if ("error" in probe && probe.error === "missing") return "won"; // pre-migration
    return "error";
  }
  // We hold the current bucket. If a sibling holds the previous one it is still
  // inside the window, so stand down and let it finish.
  const prev = await sbInsertClaim("wa_send_claims", {
    sender_key: senderKey,
    slot_key: threadTurnSlot(toDigits, bucket - 1),
  });
  if (prev === "lost") {
    await releaseThreadTurn(senderKey, toDigits, nowMs);
    return "lost";
  }
  return "won";
}

/**
 * Give the thread back early.
 *
 * A turn that ends without sending anything - silent, held, blocked - must not
 * freeze its thread for the rest of the window, or a shop's next message waits
 * a minute for nothing.
 */
export async function releaseThreadTurn(
  senderKey: string,
  toDigits: string,
  nowMs: number = Date.now()
): Promise<void> {
  if (!senderKey || !toDigits) return;
  const { sbDelete } = await import("../runtime-config");
  const slot = threadTurnSlot(toDigits, turnBucket(nowMs));
  await sbDelete(
    "wa_send_claims",
    `sender_key=eq.${encodeURIComponent(senderKey)}&slot_key=eq.${encodeURIComponent(slot)}`
  ).catch(() => {});
}
