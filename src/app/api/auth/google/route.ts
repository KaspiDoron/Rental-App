import { NextResponse } from "next/server";
import { setSessionCookie, getSession, isOwner } from "@/lib/session";
import { getConfig } from "@/lib/runtime-config";
import { getUser, registerUser, isBlocked, touchUser } from "@/lib/access";

const PHONE_RX = /^\+?[\d\s\-()]{7,17}$/;

// Google OAuth sign in (Google Identity Services credential flow).
// The client posts the ID token; we verify it against Google's tokeninfo
// endpoint server-side, then apply the same signup rules as email login.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const credential = String(body.credential ?? "");
  const phone = String(body.phone ?? "").trim();
  const acceptTerms = Boolean(body.acceptTerms);

  if (!credential) {
    return NextResponse.json({ error: "Missing Google credential." }, { status: 400 });
  }

  // Verify the ID token with Google.
  let email = "";
  let name = "";
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
      { cache: "no-store" }
    );
    const info = await res.json();
    if (!res.ok || !info.email || info.email_verified !== "true") {
      return NextResponse.json({ error: "Google sign-in could not be verified." }, { status: 401 });
    }
    const expectedAud = await getConfig("GOOGLE_OAUTH_CLIENT_ID");
    if (expectedAud && info.aud !== expectedAud) {
      return NextResponse.json({ error: "Google credential audience mismatch." }, { status: 401 });
    }
    email = String(info.email).toLowerCase();
    name = String(info.name ?? "");
  } catch {
    return NextResponse.json({ error: "Could not reach Google to verify." }, { status: 502 });
  }

  if (isBlocked(email)) {
    return NextResponse.json(
      { error: "This account has been restricted by an administrator." },
      { status: 403 }
    );
  }

  const existing = getUser(email);
  const isNew = !existing;
  if (!existing && !isOwner(email)) {
    if (!phone || !PHONE_RX.test(phone) || !acceptTerms) {
      // Client should collect phone + terms, then re-post with the credential.
      return NextResponse.json({ needsSignup: true, email, name });
    }
    await registerUser({ email, phone, name, provider: "google", acceptedTerms: true });
  } else if (!existing && isOwner(email)) {
    await registerUser({ email, name, provider: "google", acceptedTerms: true });
  } else {
    touchUser(email);
  }

  setSessionCookie(email);
  const session = await getSession();
  const { sbInsert } = await import("@/lib/runtime-config");
  await sbInsert("auth_events", [
    { email, event: isNew ? "signup" : "login", provider: "google" },
  ]);
  return NextResponse.json({ ok: true, session, isNew });
}
