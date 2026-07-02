import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { setPlan } from "@/lib/access";
import { sbInsert } from "@/lib/runtime-config";

// Called after a successful Checkout redirect. Applies the plan immediately;
// the Stripe webhook reconciles/verifies subscriptions server-side later.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { plan } = await req.json().catch(() => ({}));
  if (!["pro", "business"].includes(String(plan))) {
    return NextResponse.json({ error: "Unknown plan" }, { status: 400 });
  }
  await setPlan(session.email, plan);
  await sbInsert("billing_events", [
    { type: `plan_activated_${plan}`, verified: false, stripe_event_id: null },
  ]);
  return NextResponse.json({ ok: true });
}
