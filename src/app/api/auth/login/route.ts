import { NextResponse } from "next/server";
import { setSessionCookie, getSession, isOwner } from "@/lib/session";
import { getUser, registerUser, isBlocked, touchUser } from "@/lib/access";

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RX = /^\+?[\d\s\-()]{7,17}$/;

// Email sign in / sign up.
// - Owner signs in with email alone.
// - Existing users sign in with email alone.
// - New users must provide a phone number and accept the terms of use.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const phone = String(body.phone ?? "").trim();
  const acceptTerms = Boolean(body.acceptTerms);

  if (!EMAIL_RX.test(email)) {
    return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });
  }
  if (isBlocked(email)) {
    return NextResponse.json(
      { error: "This account has been restricted by an administrator." },
      { status: 403 }
    );
  }

  const existing = getUser(email);
  if (!existing && !isOwner(email)) {
    // New account: enforce full signup.
    if (!phone || !PHONE_RX.test(phone)) {
      return NextResponse.json(
        { needsSignup: true, error: phone ? "Enter a valid phone number." : undefined },
        { status: phone ? 400 : 200 }
      );
    }
    if (!acceptTerms) {
      return NextResponse.json(
        { needsSignup: true, error: "Please accept the Terms of Use to continue." },
        { status: 400 }
      );
    }
    await registerUser({ email, phone, provider: "email", acceptedTerms: true });
  } else if (!existing && isOwner(email)) {
    await registerUser({ email, provider: "email", acceptedTerms: true });
  } else {
    touchUser(email);
  }

  setSessionCookie(email);
  const session = await getSession();
  return NextResponse.json({ ok: true, session });
}
