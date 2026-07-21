import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { setPlan } from "@/lib/access";
import { sbInsert } from "@/lib/runtime-config";
import { isTestUser } from "@/lib/allowlist";

// Success-redirect lander. SECURITY: this endpoint is reachable by any signed-in
// user, so it must NEVER grant a paid plan on its own say-so (the old code did -
// a free self-upgrade to Ultra). The real grant happens server-side from the
// VERIFIED PayPal webhook (BILLING.SUBSCRIPTION.ACTIVATED). The ONLY instant
// grant here is the TEST_MODE sandbox, for flagged testers, where there is no
// real charge by design.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { plan } = await req.json().catch(() => ({}));
  if (!["pro", "ultra", "business"].includes(String(plan))) {
    return NextResponse.json({ error: "Unknown plan" }, { status: 400 });
  }

  const sandbox = await isTestUser(session.email).catch(() => false);
  if (sandbox) {
    await setPlan(session.email, String(plan) === "pro" ? "pro" : "ultra");
    await sbInsert("billing_events", [
      { type: `plan_activated_${plan}_sandbox`, verified: false, provider_event_id: null },
    ]);
    return NextResponse.json({ ok: true, sandbox: true, applied: String(plan) === "pro" ? "pro" : "ultra" });
  }

  // Live user: acknowledge the redirect but do NOT grant - the webhook does, once
  // payment is confirmed. The client shows "activating shortly" and re-checks /me.
  await sbInsert("billing_events", [
    { type: `checkout_returned_${plan}`, verified: false, provider_event_id: null },
  ]).catch(() => {});
  return NextResponse.json({ ok: true, pending: true });
}
