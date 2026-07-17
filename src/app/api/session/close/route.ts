import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbInsert, sbDelete, sbDeleteReturning } from "@/lib/runtime-config";
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

  // Wakeups: exact owner match (new stamped column) + the legacy LIKE sweep
  // for rows written before the column existed. The marker in step 3 is the
  // real backstop - a surviving tick sees sessionClosed and stays silent.
  await sbDelete(
    "graph_wakeups",
    `kind=eq.tick&user_email=eq.${encodeURIComponent(session.email)}`
  ).catch(() => {});
  await sbDelete(
    "graph_wakeups",
    `kind=eq.tick&thread_key=like.${encodeURIComponent(session.email + ":*")}`
  ).catch(() => {});

  // 2. Tombstone every shop that still had something pending. Wakeup-only
  //    threads without outbox rows are covered by the session-closed marker
  //    (buildTurnFromThread checks it) - tombstones here are the belt for the
  //    rows we could enumerate.
  const digits = [...new Set(purged.map((r) => r.to_number).filter(Boolean))];
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
