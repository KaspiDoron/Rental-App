import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
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
  const { plan, subscriptionId } = await req.json().catch(() => ({}));
  if (!["pro", "ultra", "business"].includes(String(plan))) {
    return NextResponse.json({ error: "Unknown plan" }, { status: 400 });
  }

  const sandbox = await isTestUser(session.email).catch(() => false);
  if (sandbox) {
    // THE SANDBOX GRANT IS DERIVED, NOT STORED - see the long note in
    // billing/checkout. Writing `app_users.plan` here made a free Test Mode
    // grant outlive the switch that granted it, which is the one thing
    // TEST_MODE promises it will not do. `getSession` already grants Ultra to
    // any flagged tester on every request, so there was never anything for this
    // write to add except permanence.
    //
    // The event is still recorded, because the owner reading billing_events
    // needs to see that a tester exercised the flow.
    await sbInsert("billing_events", [
      { type: `plan_activated_${plan}_sandbox`, verified: false, provider_event_id: null },
    ]);
    // "ultra" because that is what the session derives for a flagged tester -
    // reporting the requested tier would put this response out of step with
    // /api/auth/me on the very next read.
    return NextResponse.json({ ok: true, sandbox: true, applied: "ultra" });
  }

  await sbInsert("billing_events", [
    { type: `checkout_returned_${plan}`, verified: false, provider_event_id: null },
  ]).catch(() => {});

  // CAPTURE-CONFIRM FALLBACK: the webhook is no longer the only way to be paid.
  //
  // Waiting for the signed webhook is right, and it was also a single point of
  // failure - an unset PAYPAL_WEBHOOK_ID, a dashboard misconfiguration or one
  // lost delivery left a traveller who HAD been charged on the free tier, with
  // an "activating shortly" message that never resolved, until the owner
  // happened to notice.
  //
  // PayPal appends the subscription id to the return URL. That id arrives over
  // a channel the caller controls, so it is not believed - it is used to ASK
  // PayPal, server-side and with the secret, what the subscription is, exactly
  // as the button flow does. `plan` above remains a logged hint with no
  // influence on the tier granted.
  const claimed = String(subscriptionId ?? "").trim();
  if (claimed) {
    const { confirmPaypalSubscription } = await import("@/lib/billing/confirm-subscription");
    const outcome = await confirmPaypalSubscription({
      email: session.email,
      subscriptionId: claimed,
      intendedPlan: String(plan),
      source: "redirect",
    });
    if (outcome.ok) return NextResponse.json({ ok: true, applied: outcome.plan });
    // A failed verification is NOT an error the traveller must act on: the
    // webhook may still be in flight and will grant on arrival. Report pending
    // with the reason so the client can say something true.
    return NextResponse.json({ ok: true, pending: true, reason: outcome.error });
  }

  // No subscription id on the return (an older checkout, a stripped query
  // string): acknowledge and let the webhook do it, as before.
  return NextResponse.json({ ok: true, pending: true });
}
