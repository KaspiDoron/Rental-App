// CLOSE A SEARCH SESSION HARD - the one implementation, two callers.
//
// Extracted from /api/session/close so the TTL stand-down can reuse it: a
// hunt that quietly EXPIRED used to leave everything armed - queued outbox
// rows, strategic-wait wakeups, un-tombstoned recipients - because expiry was
// enforced only by the client dropping sessionStorage. The first agent turn
// against a stale hunt now runs this exact close (reason "ttl-expired"), so
// an expired hunt winds down the same way a cleared one does.
//
// Three guarantees, unchanged from the route that grew them:
//   1. Every queued outbound message inside the window is deleted.
//   2. Every shop the session was talking to is TOMBSTONED (wa_cancellations),
//      so even a strategic-wait wakeup that re-composes is refused at the gate.
//   3. A session-closed marker is stamped - the durable fact every other
//      surface (agent gates, push liveness, Trips) reads.

import "server-only";
import { sbInsert, sbSelect, sbDelete, sbDeleteReturning } from "./runtime-config";
import { cancelSends, pruneCancellations } from "./wa/cancellations";

export interface CloseSessionOpts {
  /** Start of the closing session's window (ms). Defaults to now - 7d. */
  fromMs?: number;
  /** The close cutoff (ms) - rows created after it belong to the NEW session. */
  beforeMs?: number;
  /** Why the session closed - stamped on the marker so Ops can tell a user
   *  clear from a quiet expiry. */
  reason?: "user" | "ttl-expired";
}

export async function closeSearchSession(
  email: string,
  opts: CloseSessionOpts = {}
): Promise<{ purged: number }> {
  const nowMs = Date.now();
  const beforeMs = Number.isFinite(opts.beforeMs) ? Math.min(Number(opts.beforeMs), nowMs) : nowMs;
  const fromMs = Number.isFinite(opts.fromMs)
    ? Math.max(Number(opts.fromMs), nowMs - 7 * 24 * 3600_000)
    : nowMs - 7 * 24 * 3600_000;
  const beforeIso = new Date(beforeMs).toISOString();
  const fromIso = new Date(fromMs).toISOString();
  const enc = encodeURIComponent(email);

  // 1. Drop what the CLOSING session still has parked - returning the
  //    recipients so each one gets a tombstone. Rows created after the
  //    cutoff belong to the new session and are left alone.
  const purged = await sbDeleteReturning<{ to_number: string }>(
    "wa_outbox",
    `sender_key=eq.${enc}&created_at=lte.${encodeURIComponent(beforeIso)}`
  ).catch(() => [] as { to_number: string }[]);

  // Wakeups: EXACT owner match on the stamped column only (the old
  // thread_key LIKE sweep was a cross-user hazard - an underscore in an email
  // is a single-char SQL wildcard). Every kind, not just tick: a surviving
  // judge wakeup still fires its drain branch against a dead session.
  await sbDelete("graph_wakeups", `user_email=eq.${enc}`).catch(() => {});

  // 2. Tombstone every shop this session was talking to - including the ones
  //    with no outbox row (already messaged, awaiting a reply), whose inbound
  //    would otherwise still trigger an auto-answer. wa_recipient_state has
  //    exactly one row per contacted shop, so this enumerates DISTINCT shops.
  //    SCOPE: only shops whose last send falls inside the closing session's
  //    own window [from, before] - earlier sessions are covered by their own
  //    close, the new session's shops have last_sent_at > before.
  const activeShops = await sbSelect<{ to_number: string }>(
    "wa_recipient_state",
    `select=to_number&sender_key=eq.${enc}&last_sent_at=gte.${encodeURIComponent(
      fromIso
    )}&last_sent_at=lte.${encodeURIComponent(beforeIso)}&limit=500`
  ).catch(() => [] as { to_number: string }[]);
  // BELT for the retry race: a shop the NEW session has already queued must
  // never be re-tombstoned by this (possibly retried) close.
  const freshRows = await sbSelect<{ to_number: string }>(
    "wa_outbox",
    `select=to_number&sender_key=eq.${enc}&created_at=gt.${encodeURIComponent(beforeIso)}&limit=200`
  ).catch(() => [] as { to_number: string }[]);
  const freshlyQueued = new Set(freshRows.map((r) => r.to_number));
  const digits = [
    ...new Set(
      [...purged.map((r) => r.to_number), ...activeShops.map((r) => r.to_number)].filter(Boolean)
    ),
  ].filter((d) => !freshlyQueued.has(d));
  for (const d of digits) {
    await cancelSends(email, d, "session-closed").catch(() => {});
  }
  // Housekeeping: stale tombstones (>14d) are meaningless - prune on this
  // rare event instead of on every hot-path request.
  await pruneCancellations(email).catch(() => {});

  // 3. Stamp the close marker (a system row in the message log - no schema
  //    change needed, and to_number "session" can never match a real thread).
  await sbInsert("whatsapp_messages", [
    {
      to_number: "session",
      body:
        opts.reason === "ttl-expired"
          ? "(search session expired - agents stood down)"
          : "(search session closed by the user)",
      type: "system",
      direction: "outbound",
      raw: { sender: email, kind: "session-closed", reason: opts.reason ?? "user" },
    },
  ]).catch(() => {});

  return { purged: purged.length };
}
