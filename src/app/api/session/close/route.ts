import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbInsert, sbDelete } from "@/lib/runtime-config";

// Close the user's search session HARD. Called whenever the user starts a NEW
// search or clears the current one. Two guarantees:
//   1. Every queued outbound message of this user is deleted - a closed
//      session must never message a shop later ("the app kept texting shops
//      after I ended the search" bug).
//   2. A session-closed marker is stamped. The agent loop treats every thread
//      whose last outbound predates this marker as CLOSED: inbound replies are
//      still stored (never lost), but the agent goes silent - no clarify, no
//      bargain, no closer. A brand-new search re-opens a shop's thread simply
//      by sending a new (post-marker) message.
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // 1. Drop EVERYTHING this user still has parked in the outbox.
  await sbDelete(
    "wa_outbox",
    `sender_key=eq.${encodeURIComponent(session.email)}`
  ).catch(() => {});

  // 2. Stamp the close marker (a system row in the message log - no schema
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

  return NextResponse.json({ ok: true });
}

// Vercel: allow slow upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
