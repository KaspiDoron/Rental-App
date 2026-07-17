import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { placeDetails } from "@/lib/google";
import { runUserAction } from "@/lib/graph/engine";
import { sendFromUser } from "@/lib/evolution";

// Pickup-consent handoff: the traveller tapped "Share my location" on a vendor
// card because the shop offered to pick them up. ONLY here - after explicit
// consent - do we send the shop the exact location, via the engine's
// pickup-location node (which composes a varied message with a Google Maps
// link). The exact location is NEVER sent without this.
//
// Body: { to?, placeId?, lat, lng }
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "Location required to share for pickup." }, { status: 400 });
  }

  let to = String(body.to ?? "").trim();
  if (!to && body.placeId) {
    const details = await placeDetails(String(body.placeId)).catch(() => null);
    to = details?.phone ?? "";
  }
  if (!to) return NextResponse.json({ sent: false, reason: "no-phone" });
  const digits = to.replace(/[^\d]/g, "");

  // EXACT-LOCATION SAFETY: the destination must be a shop THIS USER's agent
  // already messaged - a tampered client must never point precise GPS at an
  // arbitrary number. (placeId-resolved numbers are Google's, already safe.)
  if (body.to) {
    const { sbSelect } = await import("@/lib/runtime-config");
    const known = await sbSelect<{ id: number }>(
      "whatsapp_messages",
      `select=id&direction=eq.outbound&to_number=eq.${encodeURIComponent(
        digits
      )}&raw->>sender=eq.${encodeURIComponent(session.email)}&limit=1`
    ).catch(() => []);
    if (known.length === 0) {
      return NextResponse.json(
        { sent: false, reason: "unknown-destination", error: "This number is not one of your negotiation threads." },
        { status: 400 }
      );
    }
  }

  // Sharing pickup location is an explicit user action toward this shop -
  // it re-opens a previously cancelled recipient.
  {
    const { clearCancellation } = await import("@/lib/wa/cancellations");
    await clearCancellation(session.email, digits).catch(() => {});
  }

  const result = await runUserAction({
    userEmail: session.email,
    toDigits: digits,
    kind: "user-consent-pickup",
    payload: { lat, lng, pickupConsent: true },
    send: (senderKey, dest, text) => sendFromUser(senderKey, dest, text),
  });

  return NextResponse.json({
    ok: Boolean(result),
    action: result?.action ?? "none",
    delivered: result?.delivered?.delivered ?? "none",
  });
}

export const maxDuration = 60;
