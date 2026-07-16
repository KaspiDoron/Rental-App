import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { placeDetails } from "@/lib/google";
import { runUserAction } from "@/lib/graph/engine";
import { sendFromUser, disconnectInstance } from "@/lib/evolution";
import { sbSelect, sbInsert, sbDelete } from "@/lib/runtime-config";

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
  const digits = to.replace(/[^\d]/g, "");

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
  //    - the traveller is watching).
  let sent = false;
  try {
    const result = await runUserAction({
      userEmail: session.email,
      toDigits: digits,
      kind: "user-close-deal",
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
  //      respected mechanism: stamp session-closed and purge queued sends +
  //      strategic wakeups. Other shops' threads go politely silent - no
  //      "sorry, found another bike" blast, and definitely no second yes.
  await sbDelete("wa_outbox", `sender_key=eq.${encodeURIComponent(session.email)}`).catch(() => {});
  await sbDelete(
    "graph_wakeups",
    `kind=eq.tick&thread_key=like.${encodeURIComponent(session.email + ":*")}`
  ).catch(() => {});
  await sbInsert("whatsapp_messages", [
    {
      to_number: "session",
      body: "(deal locked - session closed)",
      type: "system",
      direction: "outbound",
      raw: { sender: session.email, kind: "session-closed" },
    },
  ]).catch(() => {});

  // 2) Disconnect the traveller's WhatsApp - WheelDeal steps out of the chat.
  let disconnected = false;
  try {
    await disconnectInstance(session.email);
    disconnected = true;
  } catch {
    /* best-effort - the traveller can also disconnect from Profile */
  }

  // The wa.me deep link opens the exact shop chat in the traveller's own app.
  return NextResponse.json({
    sent,
    disconnected,
    waLink: `https://wa.me/${digits}`,
  });
}

export const maxDuration = 60;
