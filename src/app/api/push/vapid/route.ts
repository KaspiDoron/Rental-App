import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { vapidPublicKey } from "@/lib/push";

// The browser needs the VAPID public key to subscribe. The `reason` field lets
// the client tell apart the two null cases that used to look identical (the bug
// where a signed-out user was told the server was "misconfigured"):
//   reason:"signin"       -> not signed in (prompt sign-in, not an error)
//   reason:"unconfigured" -> signed in but no VAPID keys set (hide the button)
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ key: null, reason: "signin" });
  const key = await vapidPublicKey();
  return NextResponse.json(key ? { key } : { key: null, reason: "unconfigured" });
}
