import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getUser, verifyPassword, setPassword } from "@/lib/access";

// Change password (any signed-in user, from the Profile page). The new hash is
// written to Supabase so it applies everywhere immediately - if that durable
// write fails we say so instead of pretending it worked.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const { current, next } = await req.json().catch(() => ({}));
  if (typeof next !== "string" || next.length < 6) {
    return NextResponse.json(
      { error: "New password needs at least 6 characters." },
      { status: 400 }
    );
  }
  const user = await getUser(session.email, { fresh: true });
  // Users with a temp password (mustChangePassword) can skip the current check.
  if (user?.passwordHash && !user.mustChangePassword) {
    if (!verifyPassword(String(current ?? ""), user.passwordHash)) {
      return NextResponse.json({ error: "Current password is wrong." }, { status: 401 });
    }
  }
  const saved = await setPassword(session.email, next, false);
  if (!saved) {
    return NextResponse.json(
      {
        error:
          "Could not save the new password to the database - your OLD password still works. Check that Supabase is connected and schema.sql has been run, then try again.",
      },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
