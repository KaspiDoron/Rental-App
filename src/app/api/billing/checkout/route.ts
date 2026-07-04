import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { createCheckoutSession, stripeConfigured, PLANS } from "@/lib/stripe";
import { createLemonCheckout, lemonConfigured } from "@/lib/lemonsqueezy";

// Start a checkout for a paid plan. Provider priority:
//   1. Lemon Squeezy (Merchant of Record - works for individuals in Israel,
//      pays out via PayPal or wire, no business entity needed)
//   2. Stripe (kept for owners who can use it)
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

  if (await lemonConfigured()) {
    const result = await createLemonCheckout(String(planId), origin, session.email);
    if (result.url) return NextResponse.json({ url: result.url, provider: "lemonsqueezy" });
    return NextResponse.json(
      { error: result.error, configured: result.configured },
      { status: result.configured ? 400 : 200 }
    );
  }

  const result = await createCheckoutSession(String(planId), origin, session.email);
  if (result.error) {
    return NextResponse.json(
      { error: result.error, configured: result.configured },
      { status: result.configured ? 400 : 200 }
    );
  }
  return NextResponse.json({ url: result.url, provider: "stripe" });
}

// Plan catalogue (no secrets - safe for any signed-in user).
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  const [lemon, stripe] = await Promise.all([lemonConfigured(), stripeConfigured()]);
  return NextResponse.json({
    plans: PLANS,
    configured: lemon || stripe,
    provider: lemon ? "lemonsqueezy" : stripe ? "stripe" : null,
  });
}
