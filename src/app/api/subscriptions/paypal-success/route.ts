import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isPaidPlan } from "@/lib/paypal-plans";

// THE APPROVAL LANDS HERE - AND IS NOT BELIEVED.
//
// PayPal's button hands the browser a subscription id once the traveller has
// approved it. That id arrives over a channel the traveller controls, so on its
// own it is a CLAIM: taking it at face value would let anyone type a string
// into a fetch and be granted Ultra.
//
// So the id is used for exactly one thing - to ask PayPal, server-side and with
// the secret, what that subscription really is. The TIER comes from the plan id
// PayPal reports, matched against the plan ids the owner configured; never from
// anything the client said it was bought for. A Pro subscription therefore
// cannot be redeemed as Ultra even by a caller who asks nicely.
//
// The plan lands in Supabase immediately, so the very next session read carries
// it - the cookie holds only an identity, never an entitlement, which is why
// there is nothing here to re-sign and no way for a stale cookie to keep
// serving a tier the traveller no longer has. The client refetches its session
// and updates in place; the webhook still arrives and is still the durable
// record of the billing relationship.

export const dynamic = "force-dynamic";

export interface PaypalSuccessRequest {
  subscriptionID: string;
  /** What the button believed it was selling. Logged, never trusted. */
  intendedPlan?: string;
}

export interface PaypalSuccessResponse {
  ok: boolean;
  plan?: "pro" | "ultra";
  error?: string;
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json<PaypalSuccessResponse>(
      { ok: false, error: "Sign in first." },
      { status: 401 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as Partial<PaypalSuccessRequest>;
  const subscriptionID = String(body.subscriptionID ?? "").trim();
  if (!subscriptionID) {
    return NextResponse.json<PaypalSuccessResponse>(
      { ok: false, error: "Missing subscription." },
      { status: 400 }
    );
  }

  const { fetchPaypalSubscription, subscriptionEntitles, tierForPaypalPlan } = await import(
    "@/lib/paypal"
  );
  const sub = await fetchPaypalSubscription(subscriptionID);
  if (!sub) {
    return NextResponse.json<PaypalSuccessResponse>(
      { ok: false, error: "We could not verify that subscription with PayPal. Nothing was charged twice - try again in a moment." },
      { status: 502 }
    );
  }
  if (!subscriptionEntitles(sub.status)) {
    return NextResponse.json<PaypalSuccessResponse>(
      { ok: false, error: `PayPal reports this subscription as ${sub.status.toLowerCase()}.` },
      { status: 409 }
    );
  }

  const tier = await tierForPaypalPlan(sub.planId);
  if (!isPaidPlan(tier)) {
    return NextResponse.json<PaypalSuccessResponse>(
      { ok: false, error: "That subscription is not one of our plans." },
      { status: 409 }
    );
  }

  const { setPlan } = await import("@/lib/access");
  await setPlan(session.email, tier);

  // The audit trail: who, which subscription, which tier, and what PayPal said.
  const { sbInsert } = await import("@/lib/runtime-config");
  await sbInsert("agent_events", [
    {
      kind: "subscription-activated",
      user_email: session.email,
      vendor_id: "",
      vendor_name: "",
      detail: JSON.stringify({
        subscriptionId: sub.id,
        planId: sub.planId,
        tier,
        status: sub.status,
        nextBillingAt: sub.nextBillingAt,
        intendedPlan: body.intendedPlan ?? null,
      }).slice(0, 800),
    },
  ]).catch(() => {});

  return NextResponse.json<PaypalSuccessResponse>({ ok: true, plan: tier });
}
