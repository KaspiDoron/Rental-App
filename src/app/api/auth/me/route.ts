import { NextResponse } from "next/server";
import { getSession, clearSessionCookie } from "@/lib/session";
import { getUser } from "@/lib/access";
import { isAllowed } from "@/lib/allowlist";

export async function GET() {
  const session = await getSession();
  // REVOCATION: a tester removed from the beta list mid-session (their 30-day
  // cookie is still valid) is signed out on their next poll - the lock stays
  // hermetic even after login.
  if (session && !(await isAllowed(session.email))) {
    clearSessionCookie();
    return NextResponse.json({ session: null, profile: null, betaBlocked: true });
  }
  const profile = session ? (await getUser(session.email)) ?? null : null;
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
        }
      : null,
  });
}
