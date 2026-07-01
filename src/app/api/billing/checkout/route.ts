import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { createCheckoutSession, PLANS } from "@/lib/stripe";

// Management-only: start a Stripe Checkout Session.
export async function POST(req: Request) {
  const session = getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { planId } = await req.json().catch(() => ({}));
  const origin = new URL(req.url).origin;
  const result = await createCheckoutSession(String(planId), origin);
  if (result.error) {
    return NextResponse.json(
      { error: result.error, configured: result.configured },
      { status: result.configured ? 400 : 200 }
    );
  }
  return NextResponse.json({ url: result.url });
}

export async function GET() {
  const session = getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { stripeConfigured } = await import("@/lib/stripe");
  return NextResponse.json({
    plans: PLANS,
    configured: await stripeConfigured(),
  });
}
