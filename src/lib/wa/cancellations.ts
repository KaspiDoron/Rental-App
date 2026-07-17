import "server-only";
import { getConfig, sbDelete, sbInsert, sbSelectStrict } from "../runtime-config";

// Cancellation tombstones - the "absolute queue deletion" guarantee.
//
// Removing a queued message must mean the shop is NEVER messaged again by the
// agents - not by the outbox drain, not by a strategic-wait wakeup that
// re-composes a fresh message, not by a retry after a worker restart. All of
// those paths converge on guardOutbound / the send moment, so the tombstone is
// enforced THERE (see wa-guard rule -2) rather than by chasing every queue.
//
// Semantics:
//   - written by: queue removal, Clear Search / session close, deal close
//   - enforced on: AUTOMATED sends only (a human explicitly pressing Send is
//     itself the re-initiation signal)
//   - cleared by: any explicit user action toward that shop (new RFQ, custom
//     message, mass-bargain selection, pickup consent, deal close message)
//   - kill switch: app_config CANCEL_GUARD = "off" disables enforcement
//     (escape hatch if a bug ever over-blocks; writes keep happening so
//     turning it back on restores protection)

export type CancelReason = "user-removed" | "session-closed" | "deal-closed";

/** Write a tombstone. Returns false when the write could not be confirmed. */
export async function cancelSends(
  senderKey: string,
  toDigits: string,
  reason: CancelReason
): Promise<boolean> {
  const digits = toDigits.replace(/[^\d]/g, "");
  if (!senderKey || !digits) return false;
  // Upsert on (sender_key, to_number): re-cancelling refreshes the reason.
  return sbInsert(
    "wa_cancellations",
    [{ sender_key: senderKey, to_number: digits, reason }],
    "sender_key,to_number"
  );
}

/** Remove the tombstone - called by every EXPLICIT user send action. */
export async function clearCancellation(senderKey: string, toDigits: string): Promise<void> {
  const digits = toDigits.replace(/[^\d]/g, "");
  if (!senderKey || !digits) return;
  await sbDelete(
    "wa_cancellations",
    `sender_key=eq.${encodeURIComponent(senderKey)}&to_number=eq.${encodeURIComponent(digits)}`
  ).catch(() => {});
}

/**
 * Is this recipient tombstoned for this sender?
 *   true  - cancelled: automated sends must be refused outright
 *   false - not cancelled (including "table not migrated yet": no tombstone
 *           can exist in a table that does not exist)
 *   null  - the truth is UNKNOWN (transient read failure): automated senders
 *           must fail CLOSED (hold + retry), never assume "not cancelled"
 */
export async function isCancelled(
  senderKey: string,
  toDigits: string
): Promise<boolean | null> {
  const digits = toDigits.replace(/[^\d]/g, "");
  if (!senderKey || !digits) return false;
  if (!(await cancelGuardEnabled())) return false;
  const res = await sbSelectStrict<{ id: number }>(
    "wa_cancellations",
    `select=id&sender_key=eq.${encodeURIComponent(senderKey)}&to_number=eq.${encodeURIComponent(
      digits
    )}&limit=1`
  );
  if ("rows" in res) return res.rows.length > 0;
  return res.error === "missing" ? false : null;
}

/** All tombstoned numbers for a user (feeds the "paused" card state). */
export async function cancelledNumbers(senderKey: string): Promise<string[]> {
  const res = await sbSelectStrict<{ to_number: string }>(
    "wa_cancellations",
    `select=to_number&sender_key=eq.${encodeURIComponent(senderKey)}&limit=100`
  );
  return "rows" in res ? res.rows.map((r) => r.to_number) : [];
}

/** Owner kill switch (default ON). */
export async function cancelGuardEnabled(): Promise<boolean> {
  const flag = await getConfig("CANCEL_GUARD").catch(() => undefined);
  return (flag ?? "").toLowerCase() !== "off";
}

/**
 * Housekeeping: tombstones older than 14 days are stale (any session they
 * protected is long gone; explicit sends clear them anyway). Called
 * opportunistically from session close - cheap and throttle-free because a
 * session close is itself rare.
 */
export async function pruneCancellations(senderKey: string): Promise<void> {
  await sbDelete(
    "wa_cancellations",
    `sender_key=eq.${encodeURIComponent(senderKey)}&created_at=lt.${encodeURIComponent(
      new Date(Date.now() - 14 * 24 * 3600_000).toISOString()
    )}`
  ).catch(() => {});
}

/** Record a suppressed send so the Ops/Health surfaces can count them. */
export async function recordSuppressedSend(
  senderKey: string,
  toDigits: string,
  kind: "cancelled-send-blocked" | "takeover-send-blocked"
): Promise<void> {
  await sbInsert("agent_events", [
    {
      kind,
      detail: `Automated message to +${toDigits.replace(/[^\d]/g, "")} suppressed (${
        kind === "cancelled-send-blocked" ? "user removed queued messages" : "human takeover"
      }) for ${senderKey}.`,
    },
  ]).catch(() => {});
}
