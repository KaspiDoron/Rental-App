import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { connectInstance, evolutionConfigured, resetInstance } from "@/lib/evolution";

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
  const { getUser, registerUser } = await import("@/lib/access");
  const profile = await getUser(session.email);
  const typed = String(body.phone ?? "").trim();
  const phone = typed || profile?.phone;
  // Persist the number the user links with to their account, so it survives
  // across sessions and is never lost between logins (durable in app_users).
  if (typed && typed !== profile?.phone) {
    await registerUser({
      email: session.email,
      phone: typed,
      name: profile?.name,
      provider: profile?.provider ?? "email",
      acceptedTerms: true,
    }).catch(() => {});
  }
  // fresh=true (the client's auto-refresh when a shown code expired, or an
  // explicit "New code" tap): guarantee a brand-new session/code by hard
  // resetting first - the previously dead-code path (B1).
  if (body.fresh === true) {
    await resetInstance(session.email).catch(() => {});
  }
  const result = await connectInstance(session.email, origin, phone);
  return NextResponse.json({ available: true, phoneUsed: phone ?? null, ...result });
}

// Vercel: allow slow upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
