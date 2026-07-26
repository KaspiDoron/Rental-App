import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { connectInstance, evolutionConfigured } from "@/lib/evolution";
import { requestOrigin } from "@/lib/request-origin";

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

  // Proxy-aware: on Cloud Run the raw request origin is the container bind
  // address; the forwarded host is the real public one. connectInstance
  // canonicalizes again (APP_DOMAIN wins) before registering the webhook.
  const origin = requestOrigin(req);
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
  // fresh=true is an EXPLICIT user "Try again / new code" tap. It is handed to
  // connectInstance as permission to rebuild, NOT executed here.
  //
  // This used to call resetInstance() first, which wrote status "disconnected"
  // and therefore made connectInstance's `existing === "connecting"` guard
  // unreachable - so EVERY refresh took the destructive logout+delete+recreate
  // path and wiped whatever handshake the user's phone was completing. Combined
  // with the client's automatic 55s code-expiry refresh that meant up to four
  // full instance rebuilds per pairing (~3.7 min of self-inflicted churn), which
  // both broke the pairing and hammered the Evolution container. connectInstance
  // now re-issues the code on the SAME instance instead.
  const result = await connectInstance(session.email, origin, phone, {
    fresh: body.fresh === true,
  });
  return NextResponse.json({ available: true, phoneUsed: phone ?? null, ...result });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
