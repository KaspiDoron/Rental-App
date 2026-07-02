import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getUser } from "@/lib/access";

export async function GET() {
  const session = await getSession();
  const profile = session ? getUser(session.email) ?? null : null;
  return NextResponse.json({
    session,
    profile: profile
      ? {
          email: profile.email,
          phone: profile.phone ?? null,
          name: profile.name ?? null,
          provider: profile.provider,
        }
      : null,
  });
}
