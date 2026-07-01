import { NextResponse } from "next/server";
import { getConfig, sbInsert } from "@/lib/runtime-config";

// Stripe webhook (scaffold). Signature verification and full subscription
// lifecycle handling land in a later pass; for now we record events so billing
// activity is visible once STRIPE_WEBHOOK_SECRET is set.
export async function POST(req: Request) {
  const payload = await req.text();
  const secret = await getConfig("STRIPE_WEBHOOK_SECRET");

  // NOTE: with `secret` present we should verify the Stripe-Signature header
  // (constant-time HMAC over the raw body). Deferred to the billing pass.
  let event: { type?: string; id?: string } = {};
  try {
    event = JSON.parse(payload);
  } catch {
    return NextResponse.json({ received: true });
  }

  await sbInsert("billing_events", [
    { stripe_event_id: event.id ?? null, type: event.type ?? "unknown", verified: Boolean(secret) },
  ]);

  return NextResponse.json({ received: true });
}
