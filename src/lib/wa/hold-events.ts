import { sbInsert } from "../runtime-config";

// WHY IS THIS MESSAGE HELD - AS A DURABLE TRAIL (owner report 3, items 4+8).
//
// The guard's hold reason lived ONLY on the mutable wa_outbox row: overwritten
// on every re-park, deleted the moment the row sent. So "this message sat for
// six hours" had no history - the owner could see WHERE a message was, never
// the path it took. Every queue() verdict now appends a `wa-hold` event, and
// the message-path view (wa/message-path.ts) reads them back chronologically.
//
// THROTTLED per (sender, shop, reason): a row re-parked every drain pass must
// not write hundreds of identical events. One event per distinct reason per
// window is the history that matters - the reason CHANGING is the signal.
//
// DEGRADES WITHOUT THE NEW COLUMNS: `decision_id`/`to_number` are newer than
// some databases this code can reach. The write is attempted WITH them first
// and retried without, so an un-migrated database loses the join, never the
// event.

const THROTTLE_MS = 10 * 60_000;
// LANE-AWARE (owner report 4): a REPLY's holds are measured in seconds-to-a-
// couple-of-minutes, so a 10-minute throttle collapsed its whole re-park story
// into one event - the exact churn the trail exists to show. Replies throttle
// at 2 minutes; cold intros keep 10 (their holds ARE minutes long, and the
// reason changing is still recorded immediately either way).
const REPLY_THROTTLE_MS = 2 * 60_000;
const lastWrite = new Map<string, number>();

/** Exposed for tests. */
export const HOLD_EVENT_THROTTLE_MS = THROTTLE_MS;
export const REPLY_HOLD_EVENT_THROTTLE_MS = REPLY_THROTTLE_MS;

/** The same "no kind means auto reply" reading as REPLY_KIND_FILTER. */
export function holdThrottleMsFor(msgKind?: string): number {
  return msgKind === "rfq" || msgKind === "custom" || msgKind === "human-manual"
    ? THROTTLE_MS
    : REPLY_THROTTLE_MS;
}

/** Test hook - resets the in-process throttle. */
export function resetHoldThrottle(): void {
  lastWrite.clear();
}

export async function recordHoldEvent(e: {
  senderKey: string;
  toNumber: string;
  reason: string;
  until?: string;
  outboxRowId?: number;
  decisionId?: string;
  msgKind?: string;
}): Promise<void> {
  const key = `${e.senderKey}|${e.toNumber}|${e.reason}`;
  const now = Date.now();
  const prev = lastWrite.get(key);
  if (prev && now - prev < holdThrottleMsFor(e.msgKind)) return;
  lastWrite.set(key, now);
  // Bound the throttle map - it lives for the process, not the request.
  if (lastWrite.size > 2000) {
    for (const [k, t] of lastWrite) if (now - t > THROTTLE_MS) lastWrite.delete(k);
  }

  const base = {
    kind: "wa-hold",
    user_email: e.senderKey,
    vendor_name: `+${e.toNumber}`,
    detail: JSON.stringify({
      reason: e.reason,
      until: e.until ?? null,
      outboxRowId: e.outboxRowId ?? null,
      decisionId: e.decisionId ?? null,
      msgKind: e.msgKind ?? null,
    }),
  };
  const ok = await sbInsert("agent_events", [
    { ...base, to_number: e.toNumber, decision_id: e.decisionId ?? null },
  ]).catch(() => false);
  if (!ok) {
    // Un-migrated columns (or a blip): keep the event, lose only the join.
    await sbInsert("agent_events", [base]).catch(() => {});
  }
}
