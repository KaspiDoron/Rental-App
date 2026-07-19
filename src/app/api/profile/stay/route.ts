// The traveller's stay (hotel/address) + precise-location consent - the ONLY
// write path for location data (Module 5).
//
// HARD GATE (owner D1): coordinates are stripped server-side unless
// shareConsent === true - sanitizeStayInput enforces it before storage, and
// getUserStay re-enforces it on every read. A tampered client cannot smuggle
// coords past consent-off, and turning the toggle OFF durably clears them.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getUserStay, setUserStay } from "@/lib/access";
import { sanitizeStayInput } from "@/lib/location";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const stay = await getUserStay(session.email);
  // getUserStay already zeroes coords without consent - safe to return as-is.
  return NextResponse.json({ stay });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const body = await req.json().catch(() => ({}));

  // Explicit clear: empty label removes the stay (and with it any coords).
  if (typeof body?.label === "string" && body.label.trim() === "") {
    await setUserStay(session.email, { label: undefined, shareConsent: false });
    return NextResponse.json({ ok: true, cleared: true });
  }

  const stay = sanitizeStayInput(body);
  if (!stay) {
    return NextResponse.json({ error: "Type your hotel or street first." }, { status: 400 });
  }
  const ok = await setUserStay(session.email, stay);
  return NextResponse.json({
    ok,
    stay: {
      label: stay.label,
      shareConsent: stay.shareConsent,
      // Echo back exactly what will be shareable - honest UI preview.
      preciseStored: Boolean(stay.shareConsent && stay.lat != null && stay.lng != null),
    },
  });
}
