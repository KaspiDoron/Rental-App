import "server-only";

// THE RETURN PATH HAD NO WAY TO GRANT ANYTHING.
//
// Two checkout flows exist. The BUTTON flow hands the browser a subscription id
// and /api/subscriptions/paypal-success verifies it server-side and grants. The
// REDIRECT flow - the primary one, the one `createPaypalCheckout` builds - sends
// the traveller to PayPal and back to `/?billing=success&plan=pro`, where
// /api/billing/confirm correctly refuses to grant on the client's say-so and
// waits for the webhook.
//
// Which is right, and also a single point of failure. If PAYPAL_WEBHOOK_ID is
// unset or wrong, if the webhook is misconfigured in the PayPal dashboard, if
// the delivery is simply lost - a traveller who has been charged sits on the
// free tier with a "activating shortly" message that never resolves, and the
// only recovery is the owner noticing.
//
// The fallback is not to start trusting the browser. It is to do on the redirect
// exactly what the button flow does: take the id PayPal appended to the return
// URL, ask PAYPAL - server side, with the secret - what that subscription is,
// and grant only what PayPal says. The client's `plan` parameter stays a hint
// that is logged and never believed, so a Pro subscription cannot be redeemed
// as Ultra by editing a query string.
//
// ONE FUNCTION, because two copies of "how a subscription becomes a plan" is
// how one of them ends up subtly more permissive than the other.

import { isPaidPlan } from "../paypal-plans";

export type ConfirmOutcome =
  | { ok: true; plan: "pro" | "ultra"; subscriptionId: string }
  | { ok: false; status: number; error: string };

/**
 * Verify a subscription id with PayPal and, if it entitles, apply the tier.
 *
 * `intendedPlan` is whatever the client believed it was buying. It is recorded
 * in the audit row and has no influence on the outcome.
 */
export async function confirmPaypalSubscription(input: {
  email: string;
  subscriptionId: string;
  intendedPlan?: string | null;
  /** Where the id came from - "button" or "redirect". Audit only. */
  source: string;
}): Promise<ConfirmOutcome> {
  const subscriptionId = String(input.subscriptionId ?? "").trim();
  if (!subscriptionId) {
    return { ok: false, status: 400, error: "Missing subscription." };
  }

  const { fetchPaypalSubscription, subscriptionEntitles, tierForPaypalPlan } = await import(
    "../paypal"
  );
  const sub = await fetchPaypalSubscription(subscriptionId);
  if (!sub) {
    return {
      ok: false,
      status: 502,
      error:
        "We could not verify that subscription with PayPal. Nothing was charged twice - try again in a moment.",
    };
  }
  if (!subscriptionEntitles(sub.status)) {
    return {
      ok: false,
      status: 409,
      error: `PayPal reports this subscription as ${sub.status.toLowerCase()}.`,
    };
  }

  // THE TIER COMES FROM PAYPAL'S PLAN ID, matched against the plan ids the owner
  // configured - never from anything the client said it was bought for.
  const tier = await tierForPaypalPlan(sub.planId);
  if (!isPaidPlan(tier)) {
    return { ok: false, status: 409, error: "That subscription is not one of our plans." };
  }

  // ONE SUBSCRIPTION, ONE ACCOUNT. The id reaches us over a channel the caller
  // controls, so a second account claiming an already-attributed subscription is
  // refused rather than granted. The real buyer returns on the redirect within
  // seconds and claims it first; nobody else can guess the id.
  const { subscriberFor } = await import("./subscription-link");
  const owner = await subscriberFor(subscriptionId).catch(() => null);
  const email = String(input.email ?? "").trim().toLowerCase();
  if (owner && owner !== email) {
    return { ok: false, status: 409, error: "That subscription belongs to another account." };
  }

  const { setPlan } = await import("../access");
  await setPlan(email, tier);

  const { sbInsert } = await import("../runtime-config");
  const { ACTIVATION_KIND } = await import("./subscription-link");
  await sbInsert("agent_events", [
    {
      kind: ACTIVATION_KIND,
      user_email: email,
      vendor_id: "",
      vendor_name: "",
      detail: JSON.stringify({
        subscriptionId: sub.id,
        planId: sub.planId,
        tier,
        status: sub.status,
        nextBillingAt: sub.nextBillingAt,
        intendedPlan: input.intendedPlan ?? null,
        source: input.source,
      }).slice(0, 800),
    },
  ]).catch(() => {});

  return { ok: true, plan: tier, subscriptionId: sub.id };
}
