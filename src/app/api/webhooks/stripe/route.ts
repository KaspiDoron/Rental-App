import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { getConfig, sbInsert } from "@/lib/runtime-config";
import { setPlan } from "@/lib/access";

// Stripe webhook. Billing runs through Lemon Squeezy today, so this endpoint
// only RECORDS events - but when STRIPE_WEBHOOK_SECRET is set the
// Stripe-Signature header is verified (constant-time HMAC over the raw body)
// and unsigned calls are rejected. Without the secret (demo mode) events are
// logged as unverified.
function stripeSignatureValid(payload: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const parts = new Map(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i), p.slice(i + 1)] as const;
    })
  );
  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !v1) return false;
  // Replay window: 5 minutes.
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v1, "hex"));
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const payload = await req.text();
  const secret = await getConfig("STRIPE_WEBHOOK_SECRET");

  if (secret && !stripeSignatureValid(payload, req.headers.get("stripe-signature"), secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: { type?: string; id?: string } = {};
  try {
    event = JSON.parse(payload);
  } catch {
    return NextResponse.json({ received: true });
  }

  await sbInsert("billing_events", [
    { stripe_event_id: event.id ?? null, type: event.type ?? "unknown", verified: Boolean(secret) },
  ]);

  // Grant the plan ONLY from a cryptographically VERIFIED completed checkout -
  // this is the sole trusted grant path for Stripe (the success-redirect confirm
  // must never grant, since any signed-in user could POST it). Requires
  // STRIPE_WEBHOOK_SECRET to be set; an unsigned/dev call never grants.
  if (secret && event.type === "checkout.session.completed") {
    const obj =
      (event as { data?: { object?: Record<string, unknown> } }).data?.object ?? {};
    const paid =
      obj.payment_status === "paid" ||
      obj.payment_status === "no_payment_required" ||
      obj.status === "complete";
    const meta = (obj.metadata as { plan?: string; email?: string } | undefined) ?? {};
    const email =
      (typeof obj.customer_email === "string" && obj.customer_email) ||
      (typeof obj.client_reference_id === "string" && obj.client_reference_id) ||
      meta.email ||
      "";
    const plan = meta.plan === "pro" ? "pro" : meta.plan === "ultra" || meta.plan === "business" ? "ultra" : null;
    if (paid && email && plan) {
      await setPlan(email, plan).catch(() => {});
    }
  }

  return NextResponse.json({ received: true });
}
