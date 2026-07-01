import { NextResponse } from "next/server";
import { setSessionCookie, getSession } from "@/lib/session";
import { touchUser, isBlocked } from "@/lib/access";

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  const { email } = await req.json().catch(() => ({ email: "" }));
  if (!email || !EMAIL_RX.test(email)) {
    return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });
  }
  if (isBlocked(email)) {
    return NextResponse.json(
      { error: "This account has been restricted by an administrator." },
      { status: 403 }
    );
  }
  touchUser(email);
  setSessionCookie(email);
  const session = getSession();
  return NextResponse.json({ ok: true, session });
}
