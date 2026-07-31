import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import {
  saveSubscription,
  subscriptionEndpoints,
  removeSubscriptions,
  vapidPublicKey,
} from "@/lib/push";

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

// The server truth for the alerts toggle: is push configured, and does this user
// have any device subscribed?
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ configured: false, on: false, devices: 0 });
  const [key, endpoints] = await Promise.all([
    vapidPublicKey(),
    subscriptionEndpoints(session.email),
  ]);
  // `endpoints` lets the client tell "on for this account" from "on for THIS
  // device" - the difference behind the field's "Alerts on", zero pushes.
  return NextResponse.json({
    configured: Boolean(key),
    on: endpoints.length > 0,
    devices: endpoints.length,
    endpoints,
  });
}

// Turn alerts OFF: remove this user's subscriptions (all, or a single endpoint).
export async function DELETE(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : undefined;
  const removed = await removeSubscriptions(session.email, endpoint);
  return NextResponse.json({ ok: true, removed });
}
