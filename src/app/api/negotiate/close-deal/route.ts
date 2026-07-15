import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { placeDetails } from "@/lib/google";
import { runUserAction } from "@/lib/graph/engine";
import { sendFromUser, disconnectInstance } from "@/lib/evolution";

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
