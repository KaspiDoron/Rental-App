import { NextResponse } from "next/server";
import { setSessionCookie, getSession, isOwner } from "@/lib/session";
import {
  getUser,
  registerUser,
  isBlocked,
  touchUser,
  verifyPassword,
  setPassword,
} from "@/lib/access";
import { sbInsert } from "@/lib/runtime-config";

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RX = /^\+?[\d\s\-()]{7,17}$/;

// The owner's bootstrap password (changeable in Profile like any user).
const OWNER_DEFAULT_PASSWORD = "KASPI123";

// Email + password auth. Accounts live durably in Supabase (app_users), so
// logins, signups and password changes work across serverless instances.
//   mode "login"  : { email, password }
//   mode "signup" : { email, phone, password, acceptTerms }
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const mode = body.mode === "signup" ? "signup" : "login";
  const email = String(body.email ?? "").trim().toLowerCase();
  const phone = String(body.phone ?? "").trim();
  const password = String(body.password ?? "");
  const acceptTerms = Boolean(body.acceptTerms);

  if (!EMAIL_RX.test(email)) {
    return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });
  }
  if (await isBlocked(email)) {
    return NextResponse.json(
      { error: "This account has been restricted by an administrator." },
      { status: 403 }
    );
  }

  if (mode === "signup") {
    if (await getUser(email, { fresh: true })) {
      return NextResponse.json(
        { error: "This email already has an account - use Log in instead." },
        { status: 400 }
      );
    }
    if (!isOwner(email)) {
      if (!PHONE_RX.test(phone)) {
        return NextResponse.json({ error: "Enter a valid phone number." }, { status: 400 });
      }
      if (password.length < 6) {
        return NextResponse.json(
          { error: "Choose a password with at least 6 characters." },
          { status: 400 }
        );
      }
      if (!acceptTerms) {
        return NextResponse.json(
          { error: "Please accept the Terms of Use to continue." },
          { status: 400 }
        );
      }
      // A user CANNOT create an account without proving they own the email:
      // email them a 6-digit code and hold the signup until it is confirmed.
      const { startEmailVerification } = await import("@/lib/verify");
      const started = await startEmailVerification({
        email,
        phone: phone || undefined,
        password,
        acceptedTerms: true,
      });
      if (!started.ok) {
        return NextResponse.json({ error: started.error }, { status: started.cooldown ? 429 : 400 });
      }
      return NextResponse.json({ needsVerification: true, email });
    }
    // Owner bootstrap: no email round-trip needed.
    await registerUser({
      email,
      phone: phone || undefined,
      password: password || OWNER_DEFAULT_PASSWORD,
      provider: "email",
      acceptedTerms: true,
    });
  } else {
    // Log in - always verify against the freshest durable record.
    let user = await getUser(email, { fresh: true });
    if (!user && isOwner(email)) {
      // Owner bootstrap on a fresh instance: create with the default password.
      user = await registerUser({
        email,
        password: OWNER_DEFAULT_PASSWORD,
        provider: "email",
        acceptedTerms: true,
      });
    }
    if (!user) {
      return NextResponse.json(
        { error: "No account with this email - tap Sign up to create one.", needsSignup: true },
        { status: 400 }
      );
    }
    if (!user.passwordHash && isOwner(email)) {
      await setPassword(email, OWNER_DEFAULT_PASSWORD);
      user = await getUser(email, { fresh: true });
    }
    if (!verifyPassword(password, user?.passwordHash)) {
      return NextResponse.json({ error: "Wrong password. Try again or use Forgot password." }, { status: 401 });
    }
    await touchUser(email);
  }

  setSessionCookie(email);
  const session = await getSession();
  await sbInsert("auth_events", [
    { email, event: mode, provider: "email" },
  ]);
  const fresh = await getUser(email);
  return NextResponse.json({
    ok: true,
    session,
    mustChangePassword: Boolean(fresh?.mustChangePassword),
    isNew: mode === "signup",
  });
}
