import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { createCheckoutSession, stripeConfigured, PLANS } from "@/lib/stripe";

// Start a Stripe Checkout Session (any signed-in user can upgrade).
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  const { planId } = await req.json().catch(() => ({}));
  const origin = new URL(req.url).origin;
  const result = await createCheckoutSession(String(planId), origin, session.email);
  if (result.error) {
    return NextResponse.json(
      { error: result.error, configured: result.configured },
      { status: result.configured ? 400 : 200 }
    );
  }
  return NextResponse.json({ url: result.url });
}

// Plan catalogue (no secrets - safe for any signed-in user).
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  return NextResponse.json({ plans: PLANS, configured: await stripeConfigured() });
}
