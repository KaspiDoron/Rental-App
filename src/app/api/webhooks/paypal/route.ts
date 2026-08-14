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

  // Fail closed: if the webhook id is set, an unverifiable call is rejected.
  const verified = webhookId ? await verifyPaypalWebhook(req.headers, raw) : false;
  if (webhookId && !verified) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  // NOT CONFIGURED IS NOT "OK". Answering 200 here told PayPal the event was
  // delivered, so the one retry channel the billing system has was consumed
  // by a deploy that could not verify anything - the event was gone for good.
  // 503 makes PayPal retry (with backoff, for days) into a deploy where the
  // doctor HAS registered the id. The event is still recorded first, so the
  // owner can see what has been knocking.
  if (!webhookId) {
    let evtType = "unparseable";
    let evtId = "";
    try {
      const b = JSON.parse(raw) as { event_type?: string; id?: string };
      evtType = String(b?.event_type ?? "unknown");
      evtId = String(b?.id ?? "");
    } catch {
      /* recorded as unparseable */
    }
    await sbInsert("billing_events", [
      { provider_event_id: evtId || null, type: `pp_unconfigured_${evtType}`, verified: false },
    ]).catch(() => {});
    return NextResponse.json(
      { error: "PAYPAL_WEBHOOK_ID is not configured - retry after setup" },
      { status: 503 }
    );
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

  // WHO does this subscription belong to?
  //
  // A PAYMENT.SALE.COMPLETED resource's `id` is the SALE id, not the
  // subscription - the subscription is `billing_agreement_id`. Reading `id`
  // first made every renewal unattributable. So a sale reads the agreement id
  // first; every other event reads the subscription `id` first.
  const isSale = event === "PAYMENT.SALE.COMPLETED";
  const subscriptionId = String(
    (isSale
      ? resource.billing_agreement_id ?? resource.id
      : resource.id ?? resource.billing_agreement_id) ?? ""
  ).trim();

  // The TRUSTED attribution is our own verified activation record
  // (`subscriberFor`), which is written ONLY by the server-side confirm flow
  // for a subscription an authenticated traveller actually claimed. `custom_id`
  // is attacker-settable: a raw PayPal checkout can carry "victim@|pro", so a
  // signature-verified CANCELLED on the attacker's own subscription would
  // downgrade the victim if the hint were allowed to win.
  //
  //   - GRANTS may bootstrap from the hint for a subscription we have not linked
  //     yet (a checkout created outside the in-app flow). Over-granting a victim
  //     a plan they did not buy is harmless, and the webhook writes no durable
  //     link from a hint, so it cannot be leveraged into a later downgrade.
  //   - DOWNGRADES trust the verified link ONLY. Without one we do not act - the
  //     reconcile sweep still catches a genuinely-lapsed subscriber.
  const linked = subscriptionId ? await subscriberFor(subscriptionId) : null;
  const grantEmail = linked || hintEmail || "";
  const downgradeEmail = linked || "";

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
  if (verified && grantEmail && activates && tier) {
    const email = grantEmail;
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
  } else if (verified && downgradeEmail) {
    const email = downgradeEmail;
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
  } else if (verified && (activates || subscriptionId)) {
    // A VERIFIED event we could not pin to a TRUSTED account. This now also
    // covers a downgrade whose only attribution was an unverified custom_id
    // hint (deliberately refused above) - money or a cancellation may be moving
    // with nobody safely attributed, so the reconcile sweep and the owner need
    // to be able to find these. The shrug leaves a durable, queryable trace
    // instead of dissolving into the generic pp_* row above, and instead of
    // acting on a hint we do not trust.
    await sbInsert("billing_events", [
      {
        provider_event_id: String(body?.id ?? "") || null,
        type: `pp_unattributed_${event || "unknown"}`,
        verified: true,
      },
    ]).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}

export const maxDuration = 60;
