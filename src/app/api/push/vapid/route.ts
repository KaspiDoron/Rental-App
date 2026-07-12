import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { vapidPublicKey } from "@/lib/push";

// The browser needs the VAPID public key to subscribe. Returns { key: null }
// when push is not configured, so the client simply hides the opt-in.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ key: null });
  return NextResponse.json({ key: await vapidPublicKey() });
}
