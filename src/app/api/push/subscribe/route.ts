import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { saveSubscription } from "@/lib/push";

// Save the signed-in user's browser push subscription so shop-reply alerts can
// reach them even when the app is closed. Available on every plan.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const sub = body.subscription ?? body;
  const ok = await saveSubscription(session.email, sub);
  return NextResponse.json({ ok });
}
