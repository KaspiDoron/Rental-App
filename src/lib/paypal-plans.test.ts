import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { PAYPAL_PLANS, isPaidPlan } from "./paypal-plans";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the plans are configured, not hard-coded", () => {
  it("each tier names the config key an owner can override", () => {
    expect(PAYPAL_PLANS.pro.configKey).toBe("PAYPAL_PLAN_PRO");
    expect(PAYPAL_PLANS.ultra.configKey).toBe("PAYPAL_PLAN_ULTRA");
  });

  it("the button styles are the ones the plans were created with", () => {
    expect(PAYPAL_PLANS.pro.style).toEqual({
      shape: "pill",
      color: "blue",
      layout: "vertical",
      label: "subscribe",
    });
    expect(PAYPAL_PLANS.ultra.style).toEqual({
      shape: "pill",
      color: "gold",
      layout: "vertical",
      label: "subscribe",
    });
  });

  it("only real paid tiers pass the guard", () => {
    expect(isPaidPlan("pro")).toBe(true);
    expect(isPaidPlan("ultra")).toBe(true);
    expect(isPaidPlan("free")).toBe(false);
    expect(isPaidPlan(undefined)).toBe(false);
    expect(isPaidPlan("PRO")).toBe(false);
  });
});

describe("the secret is server-side, and stays there", () => {
  it("no NEXT_PUBLIC_ variable ever carries the secret", () => {
    // A secret behind a NEXT_PUBLIC_ prefix is compiled into the browser
    // bundle. This is the one mistake in a PayPal integration that cannot be
    // walked back, so it is pinned rather than remembered.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        // Test files are skipped: this very file names the forbidden
        // pattern in order to forbid it.
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    walk("src");
    for (const f of files) {
      const src = read(f);
      expect(src).not.toMatch(/NEXT_PUBLIC_[A-Z_]*SECRET/);
      expect(src).not.toMatch(/NEXT_PUBLIC_PAYPAL_CLIENT_SECRET/);
    }
  });

  it("the public config route hands over the client id and NOTHING else", () => {
    const r = readCode("src/app/api/subscriptions/paypal-config/route.ts");
    expect(r).toMatch(/getConfig\("PAYPAL_CLIENT_ID"\)/);
    expect(r).not.toMatch(/PAYPAL_CLIENT_SECRET/);
    // Signed in only - a purchase surface, not a public config dump.
    expect(r).toMatch(/if \(!session\)/);
  });

  it("no real key is committed - the repo carries placeholders only", () => {
    const example = read(".env.example");
    expect(example).toMatch(/^PAYPAL_CLIENT_SECRET=$/m);
    expect(example).toMatch(/^PAYPAL_CLIENT_ID=$/m);
  });
});

describe("an approval is a claim, and is verified before anything is granted", () => {
  // The verification and the grant moved into ONE shared function so the
  // redirect return path could stop depending solely on the webhook. The
  // guarantees are unchanged; they are just no longer duplicated, so the pin
  // covers the route and the module it delegates to.
  const route = () =>
    readCode("src/app/api/subscriptions/paypal-success/route.ts") +
    readCode("src/lib/billing/confirm-subscription.ts");

  it("the subscription id is checked WITH PayPal, not trusted", () => {
    expect(route()).toMatch(/fetchPaypalSubscription\(subscriptionId\)/);
    expect(route()).toMatch(/subscriptionId: subscriptionID,/);
    expect(route()).toMatch(/subscriptionEntitles\(sub\.status\)/);
  });

  it("the TIER comes from PayPal's plan id, never from the client", () => {
    // Otherwise a Pro subscription could be redeemed as Ultra by anyone who
    // changed one string in a fetch.
    const r = route();
    expect(r).toMatch(/tierForPaypalPlan\(sub\.planId\)/);
    expect(r).not.toMatch(/setPlan\(session\.email, body\./);
    // What the client SAID it was buying is recorded in the audit row and used
    // for nothing else.
    expect(r).toMatch(/intendedPlan: body\.intendedPlan \?\? null/);
    expect(r).toMatch(/intendedPlan: input\.intendedPlan \?\? null/);
    expect(r).not.toMatch(/tier = body\./);
  });

  it("a plan is only granted to the SIGNED-IN traveller", () => {
    // The shared confirm resolves the signed-in email from its caller and never
    // from the request body.
    expect(route()).toMatch(/await setPlan\(email, tier\);/);
    expect(route()).toMatch(/email: session\.email,/);
  });

  it("every activation leaves an audit row", () => {
    expect(route()).toMatch(/kind: ACTIVATION_KIND,/);
  });

  it("the button posts the approval and grants nothing itself", () => {
    const b = readCode("src/components/billing/PayPalSubscriptionButton.tsx");
    expect(b).toMatch(/\/api\/subscriptions\/paypal-success/);
    expect(b).toMatch(/PayPalScriptProvider/);
    expect(b).toMatch(/intent: "subscription"/);
    expect(b).toMatch(/vault: true/);
    // No hand-rolled script tag - the provider owns the SDK lifecycle.
    expect(b).not.toMatch(/document\.createElement\("script"\)/);
  });

  it("both tiers are mounted in the upgrade sheet with their own styling", () => {
    const u = readCode("src/components/UpgradeSheet.tsx");
    expect(u).toMatch(/<PayPalSubscriptionButton/);
    expect(u).toMatch(/isPaidPlan\(p\.id\)/);
    expect(u).toMatch(/PayPalProvider/);
  });
});
