import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbInsert, sbSelect, sbDelete, sbDeleteReturning } from "@/lib/runtime-config";
import { cancelSends, pruneCancellations } from "@/lib/wa/cancellations";

// Close the user's search session HARD. Called whenever the user starts a NEW
// search or clears the current one. Three guarantees:
//   1. Every queued outbound message of this user is deleted - a closed
//      session must never message a shop later ("the app kept texting shops
//      after I ended the search" bug).
//   2. Every shop the session was talking to is TOMBSTONED (wa_cancellations),
//      so even a strategic-wait wakeup that would re-compose a fresh message
//      is refused at the send gate. A new explicit send clears the tombstone.
//   3. A session-closed marker is stamped. The agent loop treats every thread
//      whose last outbound predates this marker as CLOSED: inbound replies are
//      still stored (never lost), but the agent goes silent - no clarify, no
//      bargain, no closer. A brand-new search re-opens a shop's thread simply
//      by sending a new (post-marker) message.
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // 1. Drop EVERYTHING this user still has parked - returning the recipients
  //    so each one gets a tombstone. Recipients of pending wakeups are
  //    tombstone-covered too via the thread_key purge + negotiation threads
  //    are bounded (session cap 10), so the enumeration stays tiny.
  const purged = await sbDeleteReturning<{ to_number: string }>(
    "wa_outbox",
    `sender_key=eq.${encodeURIComponent(session.email)}`
  ).catch(() => [] as { to_number: string }[]);

  // Wakeups: EXACT owner match on the stamped column only. The old
  // `thread_key=like.<email>:*` sweep was a cross-user hazard - an underscore
  // in this user's email is a single-char SQL wildcard, so it could DELETE a
  // different registered user's scheduled follow-ups.
  // Delete EVERY wakeup kind (tick, judge, session-judge), not just tick: a
  // surviving judge / session-judge wakeup would still fire its drain branch
  // against the now-closed session (the "agents kept talking after I closed the
  // search" hole). The hard sessionClosed gate is the backstop, but purging the
  // wakeups means the engine never even wakes for a dead session.
  await sbDelete(
    "graph_wakeups",
    `user_email=eq.${encodeURIComponent(session.email)}`
  ).catch(() => {});

  // 2. Tombstone every shop this session was talking to. CRITICAL: not just the
  //    ones with a pending outbox row - a shop the agent already messaged and is
  //    now awaiting a reply from has NO outbox row, yet its inbound reply would
  //    (on the live LLM path) still trigger an auto-answer, because
  //    session-closed is otherwise only a SOFT director fact the LLM can
  //    override. The tombstone is the HARD, guard-enforced (fail-closed) veto,
  //    so we enumerate every recently-messaged shop and tombstone it. Bounded to
  //    recent outbound (negotiations are short-lived) and capped.
  // Source: wa_recipient_state has exactly ONE row per contacted shop (unique
  // sender_key,to_number), so this enumerates DISTINCT shops - a row-limited
  // whatsapp_messages scan could miss an early quiet shop when a heavy session
  // pushes its rows past the limit. Recency-bounded to the shops with a send in
  // the last 7 days (mid-negotiation threads always qualify); 500 covers any
  // realistic user.
  const activeShops = await sbSelect<{ to_number: string }>(
    "wa_recipient_state",
    `select=to_number&sender_key=eq.${encodeURIComponent(
      session.email
    )}&last_sent_at=gte.${encodeURIComponent(
      new Date(Date.now() - 7 * 24 * 3600_000).toISOString()
    )}&limit=500`
  ).catch(() => [] as { to_number: string }[]);
  const digits = [
    ...new Set(
      [...purged.map((r) => r.to_number), ...activeShops.map((r) => r.to_number)].filter(Boolean)
    ),
  ];
  for (const d of digits) {
    await cancelSends(session.email, d, "session-closed").catch(() => {});
  }
  // Housekeeping: stale tombstones (>14d) are meaningless - prune on this
  // rare, user-initiated event instead of on every hot-path request.
  await pruneCancellations(session.email).catch(() => {});

  // 3. Stamp the close marker (a system row in the message log - no schema
  //    change needed, and to_number "session" can never match a real thread).
  await sbInsert("whatsapp_messages", [
    {
      to_number: "session",
      body: "(search session closed by the user)",
      type: "system",
      direction: "outbound",
      raw: { sender: session.email, kind: "session-closed" },
    },
  ]).catch(() => {});

  return NextResponse.json({ ok: true, purged: purged.length });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
