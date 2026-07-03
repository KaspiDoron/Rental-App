import { NextResponse } from "next/server";
import { verifyLemonSignature } from "@/lib/lemonsqueezy";
import { setPlan } from "@/lib/access";
import { sbInsert } from "@/lib/runtime-config";

// Lemon Squeezy webhook: signature-verified plan activation. Configure in
// Lemon Squeezy -> Settings -> Webhooks with the URL
// https://<your-domain>/api/webhooks/lemonsqueezy and the same signing secret
// you paste as LEMONSQUEEZY_WEBHOOK_SECRET.
export async function POST(req: Request) {
  const raw = await req.text();
  const ok = await verifyLemonSignature(raw, req.headers.get("x-signature"));
  if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  let body: any = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }

  const event = String(body?.meta?.event_name ?? "");
  const custom = body?.meta?.custom_data ?? {};
  const email = String(
    custom.email || body?.data?.attributes?.user_email || ""
  ).toLowerCase();
  const plan = String(custom.plan ?? "");

  await sbInsert("billing_events", [
    { stripe_event_id: String(body?.data?.id ?? ""), type: `ls_${event}`, verified: true },
  ]);

  const activates = [
    "order_created",
    "subscription_created",
    "subscription_payment_success",
    "subscription_resumed",
    "subscription_unpaused",
  ].includes(event);
  const deactivates = ["subscription_expired"].includes(event);

  if (email && activates && (plan === "pro" || plan === "ultra")) {
    await setPlan(email, plan);
  } else if (email && deactivates) {
    await setPlan(email, "free");
  }

  return NextResponse.json({ ok: true });
}
