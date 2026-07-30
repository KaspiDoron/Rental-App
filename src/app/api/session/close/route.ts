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
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // A CLOSE IS SCOPED TO THE SESSION IT CLOSES. The client sends the epochs
  // that bound the closing session: `from` (when it started) and `before`
  // (when the NEW session began - i.e. the close cutoff). Everything this
  // route touches is bounded by them, which makes the close IDEMPOTENT and
  // RETRY-SAFE: a retried close can never tombstone a shop the new session
  // has since queued or messaged, and it never reaches back across every
  // shop messaged in the last 7 days (that over-reach is what painted six
  // never-removed shops as "REMOVED BY YOU" at the next search).
  const body = (await req.json().catch(() => ({}))) as { from?: number; before?: number };
  const nowMs = Date.now();
  const beforeMs = Number.isFinite(body.before)
    ? Math.min(Number(body.before), nowMs)
    : nowMs;
  const fromMs = Number.isFinite(body.from)
    ? Math.max(Number(body.from), nowMs - 7 * 24 * 3600_000)
    : nowMs - 7 * 24 * 3600_000;
  const beforeIso = new Date(beforeMs).toISOString();
  const fromIso = new Date(fromMs).toISOString();

  // 1. Drop what the CLOSING session still has parked - returning the
  //    recipients so each one gets a tombstone. Rows created after the
  //    cutoff belong to the new session and are left alone.
  const purged = await sbDeleteReturning<{ to_number: string }>(
    "wa_outbox",
    `sender_key=eq.${encodeURIComponent(session.email)}&created_at=lte.${encodeURIComponent(beforeIso)}`
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
  //    SCOPE: only shops whose last send falls inside the CLOSING session's
  //    own window [from, before]. Shops from earlier (already-closed)
  //    sessions are covered by their own close's marker; shops of the NEW
  //    session have last_sent_at > before and are untouchable here.
  const activeShops = await sbSelect<{ to_number: string }>(
    "wa_recipient_state",
    `select=to_number&sender_key=eq.${encodeURIComponent(
      session.email
    )}&last_sent_at=gte.${encodeURIComponent(fromIso)}&last_sent_at=lte.${encodeURIComponent(
      beforeIso
    )}&limit=500`
  ).catch(() => [] as { to_number: string }[]);
  // BELT for the retry race: a shop the NEW session has already queued must
  // never be re-tombstoned by this (possibly retried) close - the mass route
  // just cleared it deliberately.
  const freshRows = await sbSelect<{ to_number: string }>(
    "wa_outbox",
    `select=to_number&sender_key=eq.${encodeURIComponent(
      session.email
    )}&created_at=gt.${encodeURIComponent(beforeIso)}&limit=200`
  ).catch(() => [] as { to_number: string }[]);
  const freshlyQueued = new Set(freshRows.map((r) => r.to_number));
  const digits = [
    ...new Set(
      [...purged.map((r) => r.to_number), ...activeShops.map((r) => r.to_number)].filter(Boolean)
    ),
  ].filter((d) => !freshlyQueued.has(d));
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
