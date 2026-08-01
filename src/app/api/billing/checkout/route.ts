import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { PLANS } from "@/lib/plans";
import { createPaypalCheckout, paypalConfigured } from "@/lib/paypal";
import { publicRequestOrigin } from "@/lib/request-origin";
import { resolveSiteOrigin } from "@/lib/site";

// Start a checkout for a paid plan via PayPal Subscriptions (no merchant-
// approval gate, $0/month, supports Israeli residents + Israeli bank payouts).
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  const { killSwitchOn } = await import("@/lib/usage");
  if (await killSwitchOn()) {
    return NextResponse.json(
      { error: "Payments are temporarily paused by the owner." },
      { status: 503 }
    );
  }
  const { planId } = await req.json().catch(() => ({}));
  // Proxy-aware: PayPal return/cancel URLs must carry the PUBLIC host, not the
  // Cloud Run container bind address.
  // PAYPAL HAS TO BE ABLE TO SEND THE TRAVELLER BACK.
  //
  // `requestOrigin` deliberately keeps localhost and container hostnames valid
  // (it is used for local dev), and on Cloud Run the request can arrive with a
  // bind address rather than the public host - so a checkout could be created
  // with a return URL PayPal cannot reach, and the traveller who paid landed
  // nowhere. `publicRequestOrigin` applies the routability filter; the
  // configured site origin is the fallback, because a payment must not be
  // created against a URL nobody can follow.
  const origin = publicRequestOrigin(req) ?? (await resolveSiteOrigin());

  // TEST MODE sandbox: flagged testers get the plan applied instantly - no
  // real charge, no payment provider round-trip. Only while the owner's
  // TEST_MODE switch is on.
  try {
    const { isTestUser } = await import("@/lib/allowlist");
    if (await isTestUser(session.email)) {
      const plan = PLANS.find((p) => p.id === planId && p.amount > 0);
      if (!plan) return NextResponse.json({ error: "Choose a paid plan." }, { status: 400 });
      const { setPlan } = await import("@/lib/access");
      await setPlan(session.email, plan.id);
      return NextResponse.json({
        sandbox: true,
        provider: "test-mode",
        applied: plan.id,
      });
    }
  } catch {
    /* sandbox path is best-effort; real checkout below */
  }

  const result = await createPaypalCheckout(String(planId), origin, session.email);
  if (result.url) return NextResponse.json({ url: result.url, provider: "paypal" });
  return NextResponse.json(
    { error: result.error, configured: result.configured },
    { status: result.configured ? 400 : 200 }
  );
}

// Plan catalogue (no secrets - safe for any signed-in user).
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  const configured = await paypalConfigured();
  return NextResponse.json({
    plans: PLANS,
    configured,
    provider: configured ? "paypal" : null,
  });
}
