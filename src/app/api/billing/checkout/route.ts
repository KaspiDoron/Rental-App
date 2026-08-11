import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { PLANS } from "@/lib/plans";
import { createPaypalCheckout, paypalConfigured } from "@/lib/paypal";
import { trustedRequestOrigin } from "@/lib/request-origin";
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
  // nowhere. The configured site origin is the fallback, because a payment must
  // not be created against a URL nobody can follow.
  //
  // ALLOW-LISTED, not merely routable. This origin becomes PayPal's return URL.
  // `x-forwarded-host` is client input, so `publicRequestOrigin` alone let a
  // caller send a payer back to a page of their choosing at the end of OUR
  // checkout - a phishing surface wearing our identity, complete with a real
  // PayPal flow in front of it. trustedRequestOrigin only answers for hosts the
  // owner controls.
  const origin = (await trustedRequestOrigin(req)) ?? (await resolveSiteOrigin());

  // TEST MODE sandbox: flagged testers get the plan applied instantly - no
  // real charge, no payment provider round-trip. Only while the owner's
  // TEST_MODE switch is on.
  try {
    const { isTestUser } = await import("@/lib/allowlist");
    if (await isTestUser(session.email)) {
      const plan = PLANS.find((p) => p.id === planId && p.amount > 0);
      if (!plan) return NextResponse.json({ error: "Choose a paid plan." }, { status: 400 });
      const { setPlan } = await import("@/lib/access");
      // A grant that did not persist must not be reported as applied - the
      // tester would be shown Ultra features they do not have.
      if (!(await setPlan(session.email, plan.id))) {
        return NextResponse.json(
          { error: "Could not apply the plan right now - please try again in a moment." },
          { status: 503 }
        );
      }
      return NextResponse.json({
        sandbox: true,
        provider: "test-mode",
        applied: plan.id,
      });
    }
  } catch {
    /* sandbox path is best-effort; real checkout below */
  }

  // THE WARM-UP GATE, AND THIS IS THE ONLY PLACE IT IS REALLY ENFORCED.
  //
  // UpgradeSheet renders a locked state and the pricing page links here, but
  // both are client-side and neither is a gate - a POST to this route is one
  // fetch away. The check has to sit in front of the money.
  //
  // It runs AFTER the TEST_MODE sandbox above, which is deliberate: flagged
  // testers ride the sandbox path and are never gated, or beta testers could
  // not test the paid tiers at all.
  const { warmupStatus } = await import("@/lib/warmup");
  const warm = await warmupStatus(session.email);
  if (!warm.warmed) {
    const { warmupProgressLine } = await import("@/lib/warmup");
    return NextResponse.json(
      {
        error:
          "We want you to get the most out of Premium, so unlock it by using the app a little more first.",
        warmup: {
          remaining: warm.remaining,
          progress: warmupProgressLine(warm),
          terms: warm.terms,
        },
      },
      { status: 403 }
    );
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
  // The catalogue carries the warm-up state with it, so the upgrade sheet can
  // render the locked variant on first paint rather than flashing a buy button
  // and then withdrawing it - which would read as the price being snatched away.
  const { warmupStatus, warmupProgressLine } = await import("@/lib/warmup");
  const warm = await warmupStatus(session.email);
  return NextResponse.json({
    plans: PLANS,
    configured,
    provider: configured ? "paypal" : null,
    warmup: {
      warmed: warm.warmed,
      remaining: warm.remaining,
      progress: warmupProgressLine(warm),
      terms: warm.terms,
    },
  });
}
