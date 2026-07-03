import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getUser, registerUser } from "@/lib/access";

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
  return NextResponse.json({
    ok: true,
    profile: { email: rec.email, phone: rec.phone ?? null, name: rec.name ?? null },
  });
}
