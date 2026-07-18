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
  // different registered user's scheduled follow-ups. Any pre-column legacy row
  // it used to catch is already covered by the session-closed marker in step 3
  // (a surviving tick sees sessionClosed and stays silent), so dropping the
  // wildcard sweep loses no correctness.
  await sbDelete(
    "graph_wakeups",
    `kind=eq.tick&user_email=eq.${encodeURIComponent(session.email)}`
  ).catch(() => {});

  // 2. Tombstone every shop this session was talking to. CRITICAL: not just the
  //    ones with a pending outbox row - a shop the agent already messaged and is
  //    now awaiting a reply from has NO outbox row, yet its inbound reply would
  //    (on the live LLM path) still trigger an auto-answer, because
  //    session-closed is otherwise only a SOFT director fact the LLM can
  //    override. The tombstone is the HARD, guard-enforced (fail-closed) veto,
  //    so we enumerate every recently-messaged shop and tombstone it. Bounded to
  //    recent outbound (negotiations are short-lived) and capped.
  const recentOut = await sbSelect<{ to_number: string }>(
    "whatsapp_messages",
    `select=to_number&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      session.email
    )}&to_number=not.in.(session,takeover,cancel)&received_at=gte.${encodeURIComponent(
      new Date(Date.now() - 7 * 24 * 3600_000).toISOString()
    )}&order=received_at.desc&limit=200`
  ).catch(() => [] as { to_number: string }[]);
  const digits = [
    ...new Set(
      [...purged.map((r) => r.to_number), ...recentOut.map((r) => r.to_number)].filter(Boolean)
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

// Vercel: allow slow upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
