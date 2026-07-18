import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { placeDetails } from "@/lib/google";
import { runUserAction } from "@/lib/graph/engine";
import { sendFromUser, disconnectInstance } from "@/lib/evolution";
import { sbSelect, sbInsert, sbDelete, sbDeleteReturning } from "@/lib/runtime-config";
import { cancelSends, clearCancellation } from "@/lib/wa/cancellations";
import { digitsOnly } from "@/lib/phone";

// Close-deal handoff: the traveller confirmed a deal on a card. We (1) send the
// shop a final closing message via the engine's closing-message node, then (2)
// DISCONNECT the traveller's WhatsApp so they continue the conversation in
// their own WhatsApp app - they can reconnect anytime from Profile.
//
// Body: { to?, placeId?, pricePerDay?, currency?, fulfillment?, when?, address? }
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  let to = String(body.to ?? "").trim();
  if (!to && body.placeId) {
    const details = await placeDetails(String(body.placeId)).catch(() => null);
    to = details?.phone ?? "";
  }
  if (!to) return NextResponse.json({ sent: false, reason: "no-phone" });
  const digits = digitsOnly(to);

  // KNOWN-THREAD GUARD (same pattern as the pickup-consent route): a closing
  // message may only go to a number THIS user's agent actually negotiated
  // with. Without this, a spoofed `to` would message a stranger AND the
  // session-close side effects below would nuke the user's real negotiations.
  {
    const known = await sbSelect<{ id: number }>(
      "whatsapp_messages",
      `select=id&direction=eq.outbound&to_number=eq.${encodeURIComponent(
        digits
      )}&raw->>sender=eq.${encodeURIComponent(session.email)}&limit=1`
    ).catch(() => []);
    if (known.length === 0) {
      return NextResponse.json(
        { sent: false, reason: "unknown-destination" },
        { status: 400 }
      );
    }
  }

  // COMMITMENT LOCK: one confirmed deal at a time. If a DIFFERENT shop was
  // booked in the last 10 minutes, refuse - this is the guard against two
  // shops both being told "yes" in the same excited minute (double booking).
  try {
    const recent = await sbSelect<{ vendor_name: string; vendor_id: string | null }>(
      "bookings",
      `select=vendor_name,vendor_id&user_email=eq.${encodeURIComponent(
        session.email
      )}&status=eq.confirmed&created_at=gte.${encodeURIComponent(
        new Date(Date.now() - 10 * 60_000).toISOString()
      )}&order=created_at.desc&limit=1`
    );
    const other = recent[0];
    const thisVendorId = body.vendorId ? String(body.vendorId) : null;
    if (other && thisVendorId && other.vendor_id && other.vendor_id !== thisVendorId) {
      return NextResponse.json(
        {
          sent: false,
          reason: "already-committed",
          vendorName: other.vendor_name,
        },
        { status: 409 }
      );
    }
  } catch {
    /* lock is best-effort - the confirm dialog is still the human gate */
  }

  // 1) Tell the shop, via the closing-message node (varied, warm, no auto-delay
  //    - the traveller is watching). ORDER MATTERS: clear any tombstone on
  //    THIS shop first (confirming the deal is an explicit user action - the
  //    closing message must be allowed to leave), send, and only THEN
  //    tombstone the whole session below.
  await clearCancellation(session.email, digits).catch(() => {});
  let sent = false;
  try {
    const result = await runUserAction({
      userEmail: session.email,
      toDigits: digits,
      kind: "user-close-deal",
      // Google "open now" from the card - the SAME truth the user sees, so a
      // deal-close on a live conversation is never queued as "shop closed".
      shopOpenNow: typeof body.openNow === "boolean" ? body.openNow : undefined,
      payload: {
        pricePerDay: Number(body.pricePerDay) || undefined,
        currency: body.currency ? String(body.currency) : undefined,
        fulfillment: body.fulfillment ? String(body.fulfillment) : undefined,
        when: body.when ? String(body.when) : undefined,
        address: body.address ? String(body.address) : undefined,
      },
      send: (senderKey, dest, text) => sendFromUser(senderKey, dest, text),
    });
    sent = result?.delivered?.delivered === "sent";
  } catch {
    /* the disconnect + wa.me link below still let the traveller finish */
  }

  // 1.5) Wind the REST of the session down through the existing, engine-
  //      respected mechanism: stamp session-closed, purge queued sends +
  //      strategic wakeups (AWAITED - a race here could fire a tick against
  //      the closing session), and tombstone every recipient including this
  //      shop (the deal is done - nothing automated chases it afterwards).
  const purged = await sbDeleteReturning<{ to_number: string }>(
    "wa_outbox",
    `sender_key=eq.${encodeURIComponent(session.email)}`
  ).catch(() => [] as { to_number: string }[]);
  // EXACT owner match on the stamped column only. The old
  // `thread_key=like.<email>:*` sweep was a cross-user hazard (an underscore in
  // the email is a single-char SQL wildcard that could delete another user's
  // wakeups); the deal-closed marker below is the backstop for any pre-column row.
  await sbDelete(
    "graph_wakeups",
    `kind=eq.tick&user_email=eq.${encodeURIComponent(session.email)}`
  ).catch(() => {});
  // Tombstone every recently-messaged shop (not just outbox-pending ones): a
  // mid-negotiation sibling awaiting a reply has no outbox row, but the
  // deal-closed session must silence it too. The tombstone is the hard,
  // guard-enforced veto (session-closed alone is only a soft, LLM-overridable
  // director fact).
  const recentOut = await sbSelect<{ to_number: string }>(
    "whatsapp_messages",
    `select=to_number&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      session.email
    )}&to_number=not.in.(session,takeover,cancel)&received_at=gte.${encodeURIComponent(
      new Date(Date.now() - 7 * 24 * 3600_000).toISOString()
    )}&order=received_at.desc&limit=200`
  ).catch(() => [] as { to_number: string }[]);
  const closeDigits = [
    ...new Set(
      [digits, ...purged.map((r) => r.to_number), ...recentOut.map((r) => r.to_number)].filter(
        Boolean
      )
    ),
  ];
  for (const d of closeDigits) {
    await cancelSends(session.email, d, "deal-closed").catch(() => {});
  }
  await sbInsert("whatsapp_messages", [
    {
      to_number: "session",
      body: "(deal locked - session closed)",
      type: "system",
      direction: "outbound",
      raw: { sender: session.email, kind: "session-closed" },
    },
  ]).catch(() => {});

  // 2) The traveller's WhatsApp STAYS LINKED. Closing a deal used to
  //    logout + DELETE the instance (a full QR re-link every single time) -
  //    that hard teardown was the "my WhatsApp disconnected by itself" bug,
  //    and nothing needs it: the session-closed marker + tombstones above
  //    already silence the agents, and the wa.me link works regardless.
  //    Explicit disconnect remains available in Profile. Rollback switch:
  //    KEEP_WA_ON_CLOSE=off restores the old teardown for one release.
  let disconnected = false;
  try {
    const { getConfig } = await import("@/lib/runtime-config");
    const keep = ((await getConfig("KEEP_WA_ON_CLOSE")) ?? "").toLowerCase() !== "off";
    if (!keep) {
      await disconnectInstance(session.email);
      disconnected = true;
    }
  } catch {
    /* best-effort - the traveller can also disconnect from Profile */
  }

  // The wa.me deep link opens the exact shop chat in the traveller's own app.
  return NextResponse.json({
    sent,
    disconnected,
    stillLinked: !disconnected,
    waLink: `https://wa.me/${digits}`,
  });
}

export const maxDuration = 60;
