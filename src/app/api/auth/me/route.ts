import { NextResponse } from "next/server";
import { getSession, clearSessionCookie } from "@/lib/session";
import { getUser } from "@/lib/access";
import { isAllowed } from "@/lib/allowlist";
import { needsReacceptance, reacceptanceReason } from "@/lib/consent";
import { TERMS_VERSION } from "@/lib/legal";
import { getConfig } from "@/lib/runtime-config";

export async function GET() {
  const session = await getSession();
  // REVOCATION: a tester removed from the beta list mid-session (their 30-day
  // cookie is still valid) is signed out on their next poll - the lock stays
  // hermetic even after login.
  if (session && !(await isAllowed(session.email))) {
    clearSessionCookie();
    return NextResponse.json({ session: null, profile: null, betaBlocked: true });
  }
  // fresh: the profile (phone!) must come from the durable store, never a
  // stale per-instance cache - this is what pages read right after login.
  const profile = session ? (await getUser(session.email, { fresh: true })) ?? null : null;
  return NextResponse.json({
    session,
    profile: profile
      ? {
          email: profile.email,
          phone: profile.phone ?? null,
          name: profile.name ?? null,
          provider: profile.provider,
          plan: session?.plan ?? profile.plan,
          mustChangePassword: Boolean(profile.mustChangePassword),
          hasPassword: Boolean(profile.passwordHash),
          stayLabel: profile.stayLabel ?? null,
          stayShareConsent: Boolean(profile.stayShareConsentAt),
          // WHETHER THE TERMS IN FORCE HAVE BEEN ACCEPTED. The first-touch
          // modal blocks the app on this, and it is decided here rather than in
          // the browser: a client that computed it could simply not.
          termsVersion: profile.termsVersion ?? null,
          needsTerms: needsReacceptance(profile),
          termsReason: reacceptanceReason(profile),
        }
      : null,
    // The document's own version, so the modal can show what is being accepted
    // and a bump reaches a live client on its next poll.
    termsVersion: TERMS_VERSION,
    operatorName: await getConfig("OPERATOR_NAME").catch(() => ""),
  });
}
