import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { connectInstance, evolutionConfigured } from "@/lib/evolution";

// Start (or resume) the signed-in user's personal WhatsApp session: creates
// the Evolution instance and returns a QR code to scan from the Profile page.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  if (!(await evolutionConfigured())) {
    return NextResponse.json({
      available: false,
      error:
        "The WhatsApp connector is not set up yet (owner: add EVOLUTION_API_URL + EVOLUTION_API_KEY in Admin -> Keys).",
    });
  }

  const origin = new URL(req.url).origin;
  const body = await req.json().catch(() => ({}));
  // Pairing code needs the user's WhatsApp number - prefer the one they typed
  // now, else the phone on their profile.
  const { getUser } = await import("@/lib/access");
  const profile = await getUser(session.email);
  const phone = String(body.phone ?? "").trim() || profile?.phone;
  const result = await connectInstance(session.email, origin, phone);
  return NextResponse.json({ available: true, phoneUsed: phone ?? null, ...result });
}
