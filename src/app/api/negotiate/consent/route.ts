import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { placeDetails } from "@/lib/google";
import { runUserAction } from "@/lib/graph/engine";
import { sendFromUser } from "@/lib/evolution";
import { digitsOnly } from "@/lib/phone";

// Pickup-consent handoff: the traveller tapped "Share my location" on a vendor
// card because the shop offered to pick them up.
//
// MODULE 5 HARD GATE: this route NO LONGER reads client-posted lat/lng - the
// production leak was a stale device fix posted from the browser and relayed
// verbatim to a shop. The tap now only AUTHORIZES the share; what actually
// gets shared is the SERVER-VERIFIED stay (getUserStay), resolved through
// resolveShareableLocation by the engine: address text always, a maps pin
// ONLY when the "Share precise location" toggle stored consented coordinates.
// No stay configured -> { ok:false, reason:"no-stay" } so the UI opens the
// LocationConfig sheet instead of silently sending anything.
//
// Body: { to?, placeId?, sharePlaceId? }
//   lat/lng in the body are IGNORED by design.
//   sharePlaceId is a ONE-OFF share: the traveller is on their way and picked
//   a different place from Maps. The browser sends only Google's place id; the
//   SERVER resolves it to a name here. No coordinates cross the wire, nothing
//   is persisted, and the saved stay is untouched.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const body = await req.json().catch(() => ({}));

  // The share must have something server-verified to say.
  const { getUserStay } = await import("@/lib/access");
  const stay = await getUserStay(session.email);
  if (!stay?.label) {
    return NextResponse.json({
      ok: false,
      reason: "no-stay",
      error: "Add your hotel or address first - that's what we'll share with the shop.",
    });
  }

  let to = String(body.to ?? "").trim();
  if (!to && body.placeId) {
    const details = await placeDetails(String(body.placeId)).catch(() => null);
    to = details?.phone ?? "";
  }
  if (!to) return NextResponse.json({ sent: false, reason: "no-phone" });
  const digits = digitsOnly(to);

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

  // ONE-OFF SHARE. Resolve the place id to a NAME on the server; a label the
  // client typed is never trusted as a location fact. Failure to resolve falls
  // through to the saved stay rather than sharing something unverified.
  let stayLabelOverride: string | undefined;
  if (body.sharePlaceId) {
    const d = await placeDetails(String(body.sharePlaceId)).catch(() => null);
    const addr = (d?.address ?? "").trim();
    if (addr) stayLabelOverride = addr.slice(0, 160);
  } else if (body.shareQuery) {
    // "Where I am now": the browser reverse-geocoded its GPS point through our
    // own /api/geocode and holds a NAME, not coordinates. Re-resolve that name
    // against Google here so the address we send a shop is Google's, never a
    // string the client composed.
    const { searchPlaces } = await import("@/lib/google");
    const q = String(body.shareQuery).slice(0, 160);
    const found = await searchPlaces(q).catch(() => ({ results: [] as Array<{ label: string }> }));
    const top = found.results?.[0]?.label?.trim();
    if (top) stayLabelOverride = top.slice(0, 160);
  }

  const result = await runUserAction({
    userEmail: session.email,
    toDigits: digits,
    kind: "user-consent-pickup",
    stayLabelOverride,
    // Consent flag ONLY - the engine composes from the server-verified stay
    // (ctx.stay), never from anything the client posted.
    payload: { pickupConsent: true },
    send: (senderKey, dest, text) => sendFromUser(senderKey, dest, text),
  });

  return NextResponse.json({
    ok: Boolean(result),
    action: result?.action ?? "none",
    delivered: result?.delivered?.delivered ?? "none",
  });
}

export const maxDuration = 60;
