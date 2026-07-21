import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { PLANS } from "@/lib/plans";
import { createPaypalCheckout, paypalConfigured } from "@/lib/paypal";

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
  const origin = new URL(req.url).origin;

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
