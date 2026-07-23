import { NextResponse } from "next/server";
import { verifyPaypalWebhook } from "@/lib/paypal";
import { setPlan } from "@/lib/access";
import { getConfig, sbInsert } from "@/lib/runtime-config";

// PayPal webhook: signature-verified subscription lifecycle -> plan grants.
// Configure in PayPal -> Developer Dashboard -> Apps & Credentials -> your app
// -> Webhooks, with the URL https://<your-domain>/api/webhooks/paypal and the
// events BILLING.SUBSCRIPTION.ACTIVATED / .CANCELLED / .EXPIRED / .SUSPENDED /
// .RE-ACTIVATED (+ PAYMENT.SALE.COMPLETED for renewals). Paste the resulting
// Webhook ID as PAYPAL_WEBHOOK_ID. Without it every call is rejected as
// unverified, so a plan is NEVER granted from an unsigned request.
export async function POST(req: Request) {
  const raw = await req.text();
  const webhookId = await getConfig("PAYPAL_WEBHOOK_ID");

  // Fail closed: if the webhook id is set, an unverifiable call is rejected; if
  // it is not set yet (pre-config), we record the event but never grant.
  const verified = webhookId ? await verifyPaypalWebhook(req.headers, raw) : false;
  if (webhookId && !verified) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: any = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }

  const event = String(body?.event_type ?? "");
  const resource = body?.resource ?? {};
  // custom_id (subscription events) / custom (sale events) carries "email|plan".
  const customId = String(resource.custom_id ?? resource.custom ?? "");
  const [emailRaw, planRaw] = customId.split("|");
  const email = String(emailRaw ?? "").toLowerCase();
  const plan = String(planRaw ?? "");

  // Capture the funding source when PayPal reports it (V2-6 wallet adoption):
  // card / apple_pay / google_pay / paypal_balance. Best-effort - the field
  // location varies by event type, so read the common shapes.
  const fundingSource =
    resource?.payment_source && typeof resource.payment_source === "object"
      ? Object.keys(resource.payment_source)[0]
      : (resource?.subscriber?.payment_source
          ? Object.keys(resource.subscriber.payment_source)[0]
          : undefined);
  await sbInsert("billing_events", [
    {
      provider_event_id: String(body?.id ?? ""),
      type: `pp_${event}`,
      verified,
      ...(fundingSource ? { funding_source: fundingSource } : {}),
    },
  ]).catch(() => {});

  const activates = [
    "BILLING.SUBSCRIPTION.ACTIVATED",
    "BILLING.SUBSCRIPTION.RE-ACTIVATED",
    "PAYMENT.SALE.COMPLETED",
  ].includes(event);
  const deactivates = [
    "BILLING.SUBSCRIPTION.CANCELLED",
    "BILLING.SUBSCRIPTION.EXPIRED",
    "BILLING.SUBSCRIPTION.SUSPENDED",
  ].includes(event);

  // Only grant from a VERIFIED event (the sole trusted grant path).
  if (verified && email && activates && (plan === "pro" || plan === "ultra")) {
    await setPlan(email, plan).catch(() => {});
  } else if (verified && email && deactivates) {
    await setPlan(email, "free").catch(() => {});
  }

  return NextResponse.json({ ok: true });
}

export const maxDuration = 60;
