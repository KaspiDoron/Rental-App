import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getUser, verifyPassword, setPassword } from "@/lib/access";

// Change password (any signed-in user, from the Profile page).
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
  const user = getUser(session.email);
  // Users with a temp password (mustChangePassword) can skip the current check.
  if (user?.passwordHash && !user.mustChangePassword) {
    if (!verifyPassword(String(current ?? ""), user.passwordHash)) {
      return NextResponse.json({ error: "Current password is wrong." }, { status: 401 });
    }
  }
  await setPassword(session.email, next, false);
  return NextResponse.json({ ok: true });
}
