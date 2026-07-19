import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getUser, registerUser, setUserStay, getUserStay } from "@/lib/access";

const PHONE_RX = /^\+?[\d\s\-()]{7,17}$/;

// Update profile details (phone, name). The phone is mirrored everywhere we
// keep it (Supabase app_users). NOTE: the WhatsApp connection is tied to the
// device that scanned the QR, not to this field - changing numbers means
// disconnecting and re-scanning in the WhatsApp section.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const phone = body.phone !== undefined ? String(body.phone).trim() : undefined;
  const name = body.name !== undefined ? String(body.name).trim().slice(0, 80) : undefined;

  if (phone !== undefined && phone !== "" && !PHONE_RX.test(phone)) {
    return NextResponse.json({ error: "Enter a valid phone number." }, { status: 400 });
  }

  const existing = await getUser(session.email, { fresh: true });
  const rec = await registerUser({
    email: session.email,
    phone: phone || existing?.phone,
    name: name || existing?.name,
    provider: existing?.provider ?? "email",
    acceptedTerms: true,
  });

  // The traveller's accommodation ("where you're staying") + the explicit
  // consent to share it with shops when they ask about delivery. Consent is
  // recorded SERVER-SIDE (a tampered client cannot fake it); clearing the label
  // or the consent flag revokes sharing. Coordinates are optional (label alone
  // is enough to answer "I stay at X").
  if (body.stay !== undefined || body.stayLabel !== undefined || body.shareStayConsent !== undefined) {
    const stayLabel =
      body.stayLabel !== undefined
        ? String(body.stayLabel).trim().slice(0, 160)
        : body.stay && typeof body.stay.label === "string"
        ? String(body.stay.label).trim().slice(0, 160)
        : undefined;
    const lat = Number(body.stayLat ?? body.stay?.lat);
    const lng = Number(body.stayLng ?? body.stay?.lng);
    await setUserStay(session.email, {
      label: stayLabel,
      lat: Number.isFinite(lat) ? lat : undefined,
      lng: Number.isFinite(lng) ? lng : undefined,
      shareConsent: Boolean(body.shareStayConsent),
    });
  }

  const stay = await getUserStay(session.email);
  return NextResponse.json({
    ok: true,
    profile: {
      email: rec.email,
      phone: rec.phone ?? null,
      name: rec.name ?? null,
      stayLabel: stay?.label ?? null,
      stayShareConsent: Boolean(stay?.shareConsent),
    },
  });
}
