import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

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

  // The verification and the grant live in ONE place, shared with the redirect
  // return path - two copies of "how a subscription becomes a plan" is how one
  // of them ends up subtly more permissive than the other.
  const { confirmPaypalSubscription } = await import("@/lib/billing/confirm-subscription");
  const outcome = await confirmPaypalSubscription({
    email: session.email,
    subscriptionId: subscriptionID,
    intendedPlan: body.intendedPlan ?? null,
    source: "button",
  });
  if (!outcome.ok) {
    return NextResponse.json<PaypalSuccessResponse>(
      { ok: false, error: outcome.error },
      { status: outcome.status }
    );
  }

  return NextResponse.json<PaypalSuccessResponse>({ ok: true, plan: outcome.plan });
}
