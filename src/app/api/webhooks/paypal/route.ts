import { NextResponse } from "next/server";
import { verifyPaypalWebhook, tierForPaypalPlan } from "@/lib/paypal";
import {
  subscriberFor,
  suspendedSinceFor,
  markSubscriptionState,
  SUSPENDED_KIND,
  RESUMED_KIND,
} from "@/lib/billing/subscription-link";
import { effectForEvent, clearsSuspension } from "@/lib/billing/suspension";
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
  // custom_id (subscription events) / custom (sale events) MAY carry
  // "email|plan" - a checkout created elsewhere can set it. Subscriptions
  // created by our own button do not, so it is a hint, not the answer.
  const customId = String(resource.custom_id ?? resource.custom ?? "");
  const [emailRaw, planRaw] = customId.split("|");
  const hintEmail = String(emailRaw ?? "").toLowerCase();
  const hintPlan = String(planRaw ?? "");

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

  // WHO does this subscription belong to? The hint if PayPal carried one,
  // otherwise our own verified activation record - which is the only path that
  // exists for a subscription created by the in-app subscribe button. Without
  // this a cancellation could not be attributed to anyone, so a traveller who
  // cancelled kept their tier indefinitely.
  const subscriptionId = String(
    resource.id ?? resource.billing_agreement_id ?? ""
  ).trim();
  const email = hintEmail || (subscriptionId ? await subscriberFor(subscriptionId) : null) || "";

  // WHICH tier? PayPal's plan id is the authority, matched against the plan ids
  // the owner configured. The custom_id hint is only a fallback for a checkout
  // that predates the subscription buttons.
  const planId = String(resource.plan_id ?? "");
  let tier =
    (planId ? await tierForPaypalPlan(planId) : null) ??
    (hintPlan === "pro" || hintPlan === "ultra" ? hintPlan : null);

  // A renewal (PAYMENT.SALE.COMPLETED) names the subscription but not the plan,
  // so ask PayPal directly rather than letting a paying traveller's renewal be
  // a no-op if their tier had been cleared.
  if (!tier && activates && subscriptionId) {
    const { fetchPaypalSubscription } = await import("@/lib/paypal");
    const sub = await fetchPaypalSubscription(subscriptionId).catch(() => null);
    if (sub?.planId) tier = await tierForPaypalPlan(sub.planId);
  }

  // Only grant from a VERIFIED event (the sole trusted grant path).
  if (verified && email && activates && tier) {
    // A WEBHOOK IS THE LAST LINE - NOBODY IS WATCHING IT. There is no traveller
    // on the other end of this request to notice that the grant did not land,
    // so a failed write has to leave a trace the owner can actually find.
    // PayPal retries a non-2xx delivery, which is the recovery we want here.
    const granted = await setPlan(email, tier).catch(() => false);
    if (!granted) {
      await sbInsert("billing_events", [
        { type: `plan_grant_failed_${tier}`, verified: true, provider_event_id: String(body?.id ?? "") || null },
      ]).catch(() => {});
      console.error(`[paypal] setPlan failed for ${email} -> ${tier}; asking PayPal to retry`);
      return NextResponse.json({ error: "grant failed" }, { status: 503 });
    }
    // Payment recovered - end any open grace window so a LATER suspension
    // starts its own clock instead of inheriting an expired one.
    if (subscriptionId && clearsSuspension(event)) {
      await markSubscriptionState(RESUMED_KIND, { email, subscriptionId });
    }
  } else if (verified && email) {
    // A SUSPENSION IS NOT A CANCELLATION. PayPal suspends for a recoverable
    // payment failure and retries over about a week, sending RE-ACTIVATED when
    // the money lands - so treating it like a cancellation dropped a paying
    // traveller's agents mid-hunt and handed them back two days later with no
    // explanation of either event. A cancellation is a decision and takes
    // effect at once; a suspension gets the window.
    const suspendedSince = subscriptionId
      ? await suspendedSinceFor(subscriptionId).catch(() => null)
      : null;
    const effect = effectForEvent(event, { suspendedSince, now: Date.now() });
    if (effect === "downgrade") {
      const downgraded = await setPlan(email, "free").catch(() => false);
      if (!downgraded) {
        console.error(`[paypal] downgrade to free failed for ${email}; asking PayPal to retry`);
        return NextResponse.json({ error: "downgrade failed" }, { status: 503 });
      }
    } else if (effect === "grace" && subscriptionId && !suspendedSince) {
      // First sight: start the clock, keep the tier. A repeat SUSPENDED event
      // must not restart it, which is why the record is only written when there
      // is not one already.
      await markSubscriptionState(SUSPENDED_KIND, { email, subscriptionId });
    }
  }

  return NextResponse.json({ ok: true });
}

export const maxDuration = 60;
