import { NextResponse } from "next/server";
import { setSessionCookie, getSession } from "@/lib/session";
import { registerUser, getUser } from "@/lib/access";
import { confirmEmailVerification, startEmailVerification } from "@/lib/verify";
import { sbInsert } from "@/lib/runtime-config";

// Confirm the email-ownership code and ONLY THEN create + sign in the account.
//   POST { email, code }            -> verify + create account
//   POST { email, resend: true }    -> re-send the code
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "Missing email." }, { status: 400 });

  if (body.resend) {
    // We no longer hold the raw password here; the client re-submits signup to
    // resend. This endpoint only resends if a pending record already exists.
    return NextResponse.json({ error: "Tap Sign up again to get a fresh code." }, { status: 400 });
  }

  const code = String(body.code ?? "").trim();
  const result = await confirmEmailVerification(email, code);
  if (!result.ok || !result.pending) {
    return NextResponse.json({ error: result.error ?? "Verification failed." }, { status: 400 });
  }

  // Email proven - create the real account now.
  const p = result.pending;
  if (!(await getUser(email, { fresh: true }))) {
    await registerUser({
      email,
      phone: p.phone,
      password: p.password,
      provider: "email",
      acceptedTerms: p.acceptedTerms,
    });
  }

  setSessionCookie(email);
  const session = await getSession();
  await sbInsert("auth_events", [{ email, event: "signup_verified", provider: "email" }]);
  return NextResponse.json({ ok: true, session, isNew: true });
}

// Avoid an unused import warning while keeping the resend helper available.
void startEmailVerification;
