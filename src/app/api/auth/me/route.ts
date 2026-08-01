import { NextResponse } from "next/server";
import { getSession, clearSessionCookie } from "@/lib/session";
import { getUser } from "@/lib/access";
import { isAllowed } from "@/lib/allowlist";
import { needsReacceptance, reacceptanceReason } from "@/lib/consent";
import { TERMS_VERSION } from "@/lib/legal";
import { getConfig } from "@/lib/runtime-config";
import { tableReady } from "@/lib/schema-probe";

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

  // DO NOT RAISE A GATE YOU CANNOT CLOSE.
  //
  // The first-touch modal is non-dismissable and it closes on exactly one fact:
  // `app_users.terms_version` being written. On a database where that column
  // does not exist, the stamp 400s, `needsReacceptance` stays true, and the
  // modal returns on every single page load for every single user - a whole
  // user base locked out of the product by a legal screen that cannot record
  // the thing it is asking for.
  //
  // So the gate is conditional on the column being writable. FAIL OPEN on both
  // "missing" and "unavailable": suppressing it returns the app to exactly the
  // posture it had before this feature (signup consents on the user row, Terms
  // linked in the footer), whereas blocking everyone produces no proof AND no
  // product. `needsReacceptance` itself stays pure - it is the policy, this is
  // the precondition, and keeping them apart is what makes the policy testable.
  let gateReady = true;
  if (profile && needsReacceptance(profile)) {
    gateReady = (await tableReady("app_users", "terms_version")) === "ready";
  }

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
          needsTerms: needsReacceptance(profile) && gateReady,
          termsReason: reacceptanceReason(profile),
          // Suppressed rather than satisfied: the owner sees this on the admin
          // surface so a silently-lowered legal gate is not silent.
          termsGateDegraded: needsReacceptance(profile) && !gateReady,
        }
      : null,
    // The document's own version, so the modal can show what is being accepted
    // and a bump reaches a live client on its next poll.
    termsVersion: TERMS_VERSION,
    operatorName: await getConfig("OPERATOR_NAME").catch(() => ""),
  });
}
