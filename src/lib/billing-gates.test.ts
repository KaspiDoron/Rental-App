import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// THREE WAYS TO GET BILLING WRONG, ALL SHIPPED AT ONCE.
//
//   1. A plan SWITCH left the old subscription running. PayPal subscriptions do
//      not replace one another - approving a second one creates a second live
//      billing agreement. So Pro -> Ultra charged for both, every month, while
//      UpgradeSheet said "a new subscription replaces the old one", which PayPal
//      had never agreed to. The only escape offered was the manage link in a
//      receipt email, and cancelling from there cancels whichever one they
//      happen to click - as likely to be the NEW one, dropping a paying
//      customer to free.
//
//   2. A free TEST_MODE grant was written to the DURABLE plan column, so it
//      outlived the switch that granted it. TEST_MODE's own contract, stated in
//      session.ts, is that flipping it off "instantly returns them to their real
//      (paid) plan, since the plan is re-derived on every request".
//
//   3. The PayPal BUTTON was a second way to start a subscription and it passed
//      through neither of the gates /api/billing/checkout enforces - the owner's
//      payments kill switch, and the warm-up gate.

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("a plan switch cancels the subscription it replaces", () => {
  const confirm = readCode("src/lib/billing/confirm-subscription.ts");

  it("prior activations for THIS account are looked up and cancelled", () => {
    expect(confirm).toMatch(/activationsFor\(email\)/);
    expect(confirm).toMatch(/cancelPaypalSubscription\(/);
    // Only ids from this account's own trail - never anything a caller named.
    expect(confirm).toMatch(/\.filter\(\(id\) => id !== sub\.id\)/);
  });

  it("only a still-LIVE subscription is cancelled", () => {
    expect(confirm).toMatch(/if \(!old \|\| !subscriptionEntitles\(old\.status\)\) continue;/);
  });

  it("the cleanup runs AFTER the grant, and cannot fail the request", () => {
    const grantIdx = confirm.indexOf("const granted = await setPlan(email, tier)");
    const cleanupIdx = confirm.indexOf("activationsFor(email)");
    expect(grantIdx).toBeGreaterThan(-1);
    // A cancel that ran first and then failed to grant would leave someone
    // paying for nothing.
    expect(cleanupIdx).toBeGreaterThan(grantIdx);
    expect(confirm).toMatch(/if \(granted\) \{/);
  });

  it("the outcome is recorded either way - a failed cancel is a double charge", () => {
    expect(confirm).toMatch(/SUPERSEDED_KIND/);
    expect(confirm).toMatch(/cancelled,/);
    const link = readCode("src/lib/billing/subscription-link.ts");
    expect(link).toMatch(/SUPERSEDED_KIND = "subscription-superseded"/);
  });

  it("cancelPaypalSubscription reports the truth, and treats 422 as done", () => {
    const pp = readCode("src/lib/paypal.ts");
    const fn = pp.slice(pp.indexOf("export async function cancelPaypalSubscription"));
    expect(fn).toMatch(/if \(res\.status === 204\) return true;/);
    // Already-cancelled is the state we wanted; calling it a failure would make
    // a retry loop forever.
    expect(fn).toMatch(/if \(res\.status === 422\) return true;/);
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toMatch(/return false;/);
  });

  it("and the copy no longer promises something PayPal never agreed to", () => {
    const sheet = readCode("src/components/UpgradeSheet.tsx");
    expect(sheet).toMatch(/we cancel it for you/);
  });
});

describe("a TEST_MODE grant cannot outlive the switch", () => {
  it("neither sandbox route writes the durable plan column", () => {
    for (const p of [
      "src/app/api/billing/checkout/route.ts",
      "src/app/api/billing/confirm/route.ts",
    ]) {
      expect(readCode(p), p).not.toMatch(/setPlan\(/);
    }
  });

  it("the grant is derived per request, where it can be revoked", () => {
    const session = readCode("src/lib/session.ts");
    expect(session).toMatch(/if \(await isTestUser\(raw\.email\)\) plan = "ultra";/);
  });

  it("both routes report the tier the SESSION will derive, not the one requested", () => {
    // Reporting `pro` while getSession derives `ultra` puts the response out of
    // step with /api/auth/me on the very next read - and the derivation wins,
    // because it is the one the rest of the app asks.
    for (const p of [
      "src/app/api/billing/checkout/route.ts",
      "src/app/api/billing/confirm/route.ts",
    ]) {
      expect(readCode(p), p).toMatch(/applied: "ultra"/);
    }
  });

  it("the real money path still refuses to claim a grant that did not land", () => {
    // The invariant the removed 503s were protecting, still pinned where it
    // actually applies.
    const confirm = readCode("src/lib/billing/confirm-subscription.ts");
    expect(confirm).toMatch(/const granted = await setPlan\(email, tier\);/);
    expect(confirm).toMatch(/if \(!granted\) \{/);
    expect(confirm).toMatch(/no need to pay again/);
  });
});

describe("both purchase paths pass the same two gates", () => {
  const checkout = readCode("src/app/api/billing/checkout/route.ts");
  const config = readCode("src/app/api/subscriptions/paypal-config/route.ts");

  it.each([
    ["checkout", checkout],
    ["paypal-config (the button path)", config],
  ])("%s enforces the kill switch", (_name, code) => {
    expect(code).toMatch(/killSwitchOn\(\)/);
  });

  it.each([
    ["checkout", checkout],
    ["paypal-config (the button path)", config],
  ])("%s enforces the warm-up gate", (_name, code) => {
    expect(code).toMatch(/warmupStatus\(session\.email\)/);
    expect(code).toMatch(/warm\.warmed/);
  });

  it.each([
    ["checkout", checkout],
    ["paypal-config (the button path)", config],
  ])("%s carves out flagged testers, and only them", (_name, code) => {
    // Otherwise a beta tester could not exercise the paid tiers at all.
    expect(code).toMatch(/isTestUser/);
  });

  it("the gate sits on the CONFIG route, before a payment can exist", () => {
    // Refusing at paypal-success would mean PayPal has already taken the money
    // and we withhold the plan - worse than either failure alone. Withholding
    // the plan IDS is the only refusal that happens before a charge.
    const success = readCode("src/app/api/subscriptions/paypal-success/route.ts");
    expect(success).not.toMatch(/warmupStatus/);
    expect(config).toMatch(/planIds/);
  });
});
