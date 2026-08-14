import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// A cancellation used to change nothing.
//
// The webhook identified the traveller from `resource.custom_id`, expecting an
// "email|plan" pair. The in-app subscribe button creates subscriptions with
// `plan_id` alone, so custom_id is empty on every subscription this app has
// ever created - the webhook had a cancellation it could not attribute, and the
// traveller kept their tier forever. Nobody noticed because activation is
// granted by a DIFFERENT route.

describe("a subscription can always be traced back to a traveller", () => {
  const hook = () => readCode("src/app/api/webhooks/paypal/route.ts");

  it("the account is resolved from OUR verified record when PayPal carries no hint", () => {
    const h = hook();
    expect(h).toMatch(/subscriberFor\(subscriptionId\)/);
    expect(h).toMatch(/hintEmail \|\|/);
  });

  it("the id is read from both shapes PayPal uses", () => {
    // Subscription events carry `resource.id`; a renewal sale carries
    // `resource.billing_agreement_id`.
    const h = hook();
    expect(h).toMatch(/resource\.id/);
    expect(h).toMatch(/resource\.billing_agreement_id/);
  });

  it("the record is matched on the EXACT subscription id, not a substring", () => {
    // `ilike.*id*` is the query; a JSON re-check is what makes it exact.
    const s = readCode("src/lib/billing/subscription-link.ts");
    expect(s).toMatch(/JSON\.parse\(detail\)/);
    expect(s).toMatch(/String\(parsed\.subscriptionId \?\? ""\) === id/);
  });

  it("no verified record means no downgrade - a hint can never revoke a plan", () => {
    // A subscription we never activated must not be able to alter an account.
    const s = readCode("src/lib/billing/subscription-link.ts");
    expect(s).toMatch(/return null/);
    const h = hook();
    // The two attribution channels are now split by stakes: a GRANT may
    // bootstrap from the attacker-settable custom_id hint (harmless), but a
    // DOWNGRADE trusts ONLY the verified link. `downgradeEmail = linked || ""`,
    // never the hint - so a signature-verified CANCELLED carrying "victim@|pro"
    // on the attacker's own subscription cannot downgrade the victim.
    expect(h).toMatch(/const downgradeEmail = linked \|\| ""/);
    expect(h).toMatch(/if \(verified && grantEmail && activates && tier\)/);
    expect(h).toMatch(/\} else if \(verified && downgradeEmail\) \{/);
  });
});

describe("the TIER comes from PayPal's plan, not from the caller", () => {
  const hook = () => readCode("src/app/api/webhooks/paypal/route.ts");

  it("the plan id is matched against the configured plans", () => {
    expect(hook()).toMatch(/tierForPaypalPlan\(planId\)/);
  });

  it("a renewal that names no plan is looked up rather than dropped", () => {
    // PAYMENT.SALE.COMPLETED carries no plan_id. Dropping it would make a
    // paying traveller's renewal a no-op if their tier had been cleared.
    const h = hook();
    expect(h).toMatch(/if \(!tier && activates && subscriptionId\)/);
    expect(h).toMatch(/fetchPaypalSubscription\(subscriptionId\)/);
  });

  it("an unsigned webhook still grants nothing", () => {
    const h = hook();
    expect(h).toMatch(/if \(webhookId && !verified\)/);
    expect(h).toMatch(/status: 401/);
  });

  it("every lifecycle event the PayPal dashboard must be told to send is handled", () => {
    // Documented in docs/LAUNCH-wheeldeal.pro.md; pinned here so the two cannot
    // drift - a missing checkbox in the dashboard is invisible until a
    // cancellation silently does nothing.
    // The events are handled across TWO files since the suspension grace
    // landed: activation in the route, the terminal/recoverable distinction in
    // the policy. Both are part of the handling surface.
    const h = hook() + readCode("src/lib/billing/suspension.ts");
    const doc = read("docs/LAUNCH-wheeldeal.pro.md");
    for (const event of [
      "BILLING.SUBSCRIPTION.ACTIVATED",
      "BILLING.SUBSCRIPTION.RE-ACTIVATED",
      "PAYMENT.SALE.COMPLETED",
      "BILLING.SUBSCRIPTION.CANCELLED",
      "BILLING.SUBSCRIPTION.EXPIRED",
      "BILLING.SUBSCRIPTION.SUSPENDED",
    ]) {
      expect(h, `${event} not handled`).toContain(event);
      expect(doc, `${event} not documented`).toContain(event);
    }
  });
});
