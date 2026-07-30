import "server-only";
import { getConfig, sbDelete, sbInsert, sbSelectStrict } from "../runtime-config";
import { parseFlag } from "../config-flags";
import { digitsOnly } from "../phone";

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

// MIGRATION-FREE FALLBACK: the dedicated wa_cancellations table only exists
// after the owner re-runs schema.sql - but "remove must be permanent" cannot
// wait for a migration. Marker rows in whatsapp_messages (a table that has
// existed since day one - the same trick the session-closed flag uses) carry
// the tombstone until the table is available: to_number="cancel",
// raw {sender, digits, kind: "cancelled-shop" | "cancel-cleared"}. The
// NEWEST marker for a (sender, shop) pair wins.

const MARKER_WINDOW_MS = 14 * 24 * 3600_000;

async function writeMarker(
  senderKey: string,
  digits: string,
  kind: "cancelled-shop" | "cancel-cleared",
  reason?: string
): Promise<boolean> {
  return sbInsert("whatsapp_messages", [
    {
      to_number: "cancel",
      body: kind === "cancelled-shop" ? `(stopped messages to +${digits})` : `(re-opened +${digits})`,
      type: "system",
      direction: "outbound",
      raw: { sender: senderKey, digits, kind, ...(reason ? { reason } : {}) },
    },
  ]);
}

/** Newest marker verdict: true=cancelled, false=cleared/none, null=unreadable. */
async function markerSaysCancelled(senderKey: string, digits: string): Promise<boolean | null> {
  const res = await sbSelectStrict<{ raw: { kind?: string } | null }>(
    "whatsapp_messages",
    `select=raw&to_number=eq.cancel&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      senderKey
    )}&raw->>digits=eq.${encodeURIComponent(digits)}&received_at=gte.${encodeURIComponent(
      new Date(Date.now() - MARKER_WINDOW_MS).toISOString()
    )}&order=received_at.desc&limit=1`
  );
  if (!("rows" in res)) return res.error === "missing" ? false : null;
  return res.rows[0]?.raw?.kind === "cancelled-shop";
}

/** Write a tombstone. Returns false when NO durable store confirmed it. */
export async function cancelSends(
  senderKey: string,
  toDigits: string,
  reason: CancelReason
): Promise<boolean> {
  const digits = digitsOnly(toDigits);
  if (!senderKey || !digits) return false;
  // Upsert on (sender_key, to_number): re-cancelling refreshes the reason.
  const table = await sbInsert(
    "wa_cancellations",
    [{ sender_key: senderKey, to_number: digits, reason }],
    "sender_key,to_number"
  );
  // The marker is ALWAYS written too: it protects the pre-migration present
  // AND survives the moment the table appears (an empty new table must not
  // silently reopen shops cancelled via markers).
  const marker = await writeMarker(senderKey, digits, "cancelled-shop", reason);
  return table || marker;
}

/** Remove the tombstone - called by every EXPLICIT user send action. */
export async function clearCancellation(senderKey: string, toDigits: string): Promise<void> {
  const digits = digitsOnly(toDigits);
  if (!senderKey || !digits) return;
  await sbDelete(
    "wa_cancellations",
    `sender_key=eq.${encodeURIComponent(senderKey)}&to_number=eq.${encodeURIComponent(digits)}`
  ).catch(() => {});
  // Only append a cleared-marker when a cancelled-marker is actually in
  // force - keeps the marker trail short on the common path.
  const m = await markerSaysCancelled(senderKey, digits).catch(() => false);
  if (m === true) await writeMarker(senderKey, digits, "cancel-cleared").catch(() => {});
}

/**
 * Is this recipient tombstoned for this sender?
 *   true  - cancelled: automated sends must be refused outright
 *   false - not cancelled
 *   null  - the truth is UNKNOWN (transient read failure): automated senders
 *           must fail CLOSED (hold + retry), never assume "not cancelled"
 * Checks the dedicated table first, then the marker trail - a cancel
 * recorded EITHER way is honored, so removal works before, during and after
 * the schema migration.
 */
export async function isCancelled(
  senderKey: string,
  toDigits: string
): Promise<boolean | null> {
  const digits = digitsOnly(toDigits);
  if (!senderKey || !digits) return false;
  if (!(await cancelGuardEnabled())) return false;
  const res = await sbSelectStrict<{ id: number }>(
    "wa_cancellations",
    `select=id&sender_key=eq.${encodeURIComponent(senderKey)}&to_number=eq.${encodeURIComponent(
      digits
    )}&limit=1`
  );
  if ("rows" in res && res.rows.length > 0) return true;
  const tableUnavailable = !("rows" in res) && res.error === "unavailable";
  const marker = await markerSaysCancelled(senderKey, digits);
  if (marker === true) return true;
  if (marker === null || tableUnavailable) return null; // unknown -> fail closed
  return false;
}

/** All tombstoned numbers for a user (feeds the "paused" card state). */
export async function cancelledNumbers(senderKey: string): Promise<string[]> {
  const out = new Set<string>();
  const res = await sbSelectStrict<{ to_number: string }>(
    "wa_cancellations",
    `select=to_number&sender_key=eq.${encodeURIComponent(senderKey)}&limit=100`
  );
  if ("rows" in res) for (const r of res.rows) out.add(r.to_number);
  // Fold the marker trail (newest marker per shop wins).
  const markers = await sbSelectStrict<{ raw: { digits?: string; kind?: string } | null }>(
    "whatsapp_messages",
    `select=raw&to_number=eq.cancel&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      senderKey
    )}&received_at=gte.${encodeURIComponent(
      new Date(Date.now() - MARKER_WINDOW_MS).toISOString()
    )}&order=received_at.desc&limit=200`
  );
  if ("rows" in markers) {
    const seen = new Set<string>();
    for (const m of markers.rows) {
      const d = m.raw?.digits;
      if (!d || seen.has(d)) continue;
      seen.add(d);
      if (m.raw?.kind === "cancelled-shop") out.add(d);
    }
  }
  return [...out];
}

/** Owner kill switch (default ON). One flag dialect - "false"/"0"/"no" and
 * a stray " off " all disable it too; an unreadable value keeps it ON. */
export async function cancelGuardEnabled(): Promise<boolean> {
  const flag = await getConfig("CANCEL_GUARD").catch(() => undefined);
  return parseFlag(flag, true);
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
      detail: `Automated message to +${digitsOnly(toDigits)} suppressed (${
        kind === "cancelled-send-blocked" ? "user removed queued messages" : "human takeover"
      }) for ${senderKey}.`,
    },
  ]).catch(() => {});
}
