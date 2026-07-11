import { NextResponse } from "next/server";
import { setSessionCookie, getSession } from "@/lib/session";
import { registerUser, getUser } from "@/lib/access";
import { confirmEmailVerification, startEmailVerification, clearEmailVerification } from "@/lib/verify";
import { sbInsert } from "@/lib/runtime-config";
import { authLockLeft, noteAuthFailure, clearAuthFailures } from "@/lib/cooldown";

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

  // PRIVATE-BETA LOCK (defense in depth): even a valid code cannot create an
  // account unless the email is invited.
  const { allowedPlanFor, BETA_BLOCK_MESSAGE } = await import("@/lib/allowlist");
  const invitedPlan = await allowedPlanFor(email);
  if (invitedPlan === null) {
    return NextResponse.json({ error: BETA_BLOCK_MESSAGE, betaBlocked: true }, { status: 403 });
  }

  // Throttle 6-digit code guessing: the code space is only 1e6, so without a
  // cap it is brute-forceable within the 15-min TTL. Lock after 5 wrong codes
  // and discard the pending record so it cannot be guessed further.
  const lockLeft = await authLockLeft(email, "verify");
  if (lockLeft > 0) {
    await clearEmailVerification(email);
    return NextResponse.json(
      { error: `Too many wrong codes - tap Sign up again to get a fresh code.` },
      { status: 429 }
    );
  }

  const code = String(body.code ?? "").trim();
  const result = await confirmEmailVerification(email, code);
  if (!result.ok || !result.pending) {
    // Count only a genuine wrong-code guess (not an expired/corrupt record).
    if (/wrong code/i.test(result.error ?? "")) {
      const { locked } = await noteAuthFailure(email, "verify", 5, 15, 15);
      if (locked) await clearEmailVerification(email);
    }
    return NextResponse.json({ error: result.error ?? "Verification failed." }, { status: 400 });
  }
  clearAuthFailures(email, "verify");

  // Email proven - create the real account now (pinned to the invited plan).
  const p = result.pending;
  if (!(await getUser(email, { fresh: true }))) {
    await registerUser({
      email,
      phone: p.phone,
      password: p.password,
      provider: "email",
      acceptedTerms: p.acceptedTerms,
      plan: invitedPlan,
    });
  }

  setSessionCookie(email);
  const session = await getSession();
  await sbInsert("auth_events", [{ email, event: "signup_verified", provider: "email" }]);
  return NextResponse.json({ ok: true, session, isNew: true });
}

// Avoid an unused import warning while keeping the resend helper available.
void startEmailVerification;
