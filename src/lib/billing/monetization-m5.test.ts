import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import {
  effectForEvent,
  clearsSuspension,
  graceDaysLeft,
  SUSPENSION_GRACE_MS,
} from "./suspension";
import { campaignVerdict, activeCampaigns, campaignKey } from "../wa/campaigns";
import { PLAN_CAPACITY } from "../wa/capacity";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const DAY = 86_400_000;

// FOUR WAYS THE MONEY PATH FAILED QUIETLY.

describe("REPRODUCTION: a declined card took the agents away mid-hunt", () => {
  it("a suspension keeps the tier on first sight", () => {
    // PayPal suspends for a RECOVERABLE payment failure and retries on its own
    // schedule. Treating it like a cancellation dropped a paying traveller to
    // free on a beach with a live negotiation running, and handed the tier back
    // two days later with no explanation of either event.
    expect(effectForEvent("BILLING.SUBSCRIPTION.SUSPENDED", { now: 0 })).toBe("grace");
  });

  it("...and keeps it for the whole grace window", () => {
    const since = 1_000_000;
    expect(
      effectForEvent("BILLING.SUBSCRIPTION.SUSPENDED", {
        suspendedSince: since,
        now: since + 6 * DAY,
      })
    ).toBe("grace");
  });

  it("...and drops it once the window has run out", () => {
    const since = 1_000_000;
    expect(
      effectForEvent("BILLING.SUBSCRIPTION.SUSPENDED", {
        suspendedSince: since,
        now: since + SUSPENSION_GRACE_MS,
      })
    ).toBe("downgrade");
  });

  it("the window outlasts PayPal's dunning retries, or it is not a grace", () => {
    expect(SUSPENSION_GRACE_MS).toBeGreaterThanOrEqual(7 * DAY);
  });

  it("a CANCELLATION is a decision and still takes effect at once", () => {
    expect(effectForEvent("BILLING.SUBSCRIPTION.CANCELLED", { now: 0 })).toBe("downgrade");
    expect(effectForEvent("BILLING.SUBSCRIPTION.EXPIRED", { now: 0 })).toBe("downgrade");
  });

  it("an unrelated event changes nothing", () => {
    expect(effectForEvent("BILLING.SUBSCRIPTION.UPDATED", { now: 0 })).toBe("keep");
    expect(effectForEvent("", { now: 0 })).toBe("keep");
  });

  it("recovery clears the window so a LATER suspension starts its own clock", () => {
    expect(clearsSuspension("BILLING.SUBSCRIPTION.RE-ACTIVATED")).toBe(true);
    expect(clearsSuspension("PAYMENT.SALE.COMPLETED")).toBe(true);
    expect(clearsSuspension("BILLING.SUBSCRIPTION.CANCELLED")).toBe(false);
  });

  it("the days-left figure is honest at both ends", () => {
    const since = 1_000_000;
    expect(graceDaysLeft(null, since)).toBe(7);
    expect(graceDaysLeft(since, since + SUSPENSION_GRACE_MS)).toBe(0);
    expect(graceDaysLeft(since, since + 3 * DAY)).toBe(4);
  });

  it("and the webhook actually asks - it no longer lumps SUSPENDED in", () => {
    const hook = readCode("src/app/api/webhooks/paypal/route.ts");
    expect(hook).not.toMatch(/"BILLING\.SUBSCRIPTION\.SUSPENDED",\s*\]\.includes\(event\)/);
    expect(hook).toMatch(/const effect = effectForEvent\(event, \{ suspendedSince, now: Date\.now\(\) \}\);/);
    expect(hook).toMatch(/if \(effect === "downgrade"\)/);
  });

  it("a repeat SUSPENDED event does not restart the clock", () => {
    const hook = readCode("src/app/api/webhooks/paypal/route.ts");
    expect(hook).toMatch(/effect === "grace" && subscriptionId && !suspendedSince/);
  });
});

describe("REPRODUCTION: concurrentCampaigns, sold since Module 6, never read", () => {
  it("the plan tiers really do differ", () => {
    expect(PLAN_CAPACITY.free.concurrentCampaigns).toBeLessThan(
      PLAN_CAPACITY.pro.concurrentCampaigns
    );
    expect(PLAN_CAPACITY.pro.concurrentCampaigns).toBeLessThan(
      PLAN_CAPACITY.ultra.concurrentCampaigns
    );
  });

  it("free may run one hunt, and a second is refused", () => {
    const pending = [{ kind: "rfq", campaign: "111" }];
    expect(campaignVerdict("free", pending, "111").allowed).toBe(true);
    const second = campaignVerdict("free", pending, "222");
    expect(second.allowed).toBe(false);
    expect(second.limit).toBe(1);
    expect(second.reason).toMatch(/upgrade/i);
  });

  it("...and pro may run two", () => {
    const pending = [{ kind: "rfq", campaign: "111" }];
    expect(campaignVerdict("pro", pending, "222").allowed).toBe(true);
    expect(
      campaignVerdict("pro", [...pending, { kind: "rfq", campaign: "222" }], "333").allowed
    ).toBe(false);
  });

  it("THE ELEVENTH SHOP OF A HUNT ALREADY IN FLIGHT IS ALWAYS ALLOWED", () => {
    // The shops of one batch arrive one request at a time. Refusing a shop of a
    // hunt the traveller already started would be a bug wearing a limit's
    // clothes.
    const pending = Array.from({ length: 10 }, () => ({ kind: "rfq", campaign: "111" }));
    expect(campaignVerdict("free", pending, "111").allowed).toBe(true);
  });

  it("replies and typed messages are not campaigns", () => {
    const pending = [
      { kind: "auto-answer", campaign: "111" },
      { kind: "custom", campaign: "222" },
      { kind: "auto-bargain", campaign: "333" },
    ];
    expect(activeCampaigns(pending).size).toBe(0);
    expect(campaignVerdict("free", pending, "999").allowed).toBe(true);
  });

  it("an unstamped row cannot be used to slip past the limit", () => {
    // An older client that stamps nothing shares ONE anonymous bucket rather
    // than being ignored.
    expect(campaignKey(undefined)).toBe("legacy");
    const pending = [
      { kind: "rfq", campaign: null },
      { kind: "rfq", campaign: undefined },
    ];
    expect(activeCampaigns(pending).size).toBe(1);
    expect(campaignVerdict("free", pending, "new").allowed).toBe(false);
  });

  it("the route enforces it and the card stamps it", () => {
    const route = readCode("src/app/api/outreach/route.ts");
    expect(route).toMatch(/const \{ campaignVerdict \} = await import\("@\/lib\/wa\/campaigns"\);/);
    expect(route).toMatch(/reason: "concurrent-campaigns",/);
    expect(route).toMatch(/\.\.\.\(body\.campaign \? \{ campaign: String\(body\.campaign\) \} : \{\}\),/);
    const card = readCode("src/components/VendorCard.tsx");
    expect(card).toMatch(/campaign: searchEpoch \|\| undefined,/);
  });
});

describe("REPRODUCTION: a paid traveller stranded by one lost webhook", () => {
  const confirm = readCode("src/app/api/billing/confirm/route.ts");
  const shared = readCode("src/lib/billing/confirm-subscription.ts");

  it("the return path can now verify with PayPal directly", () => {
    expect(confirm).toMatch(/const claimed = String\(subscriptionId \?\? ""\)\.trim\(\);/);
    expect(confirm).toMatch(/confirmPaypalSubscription\(\{/);
    expect(confirm).toMatch(/source: "redirect",/);
  });

  it("...and the client forwards the id PayPal appended", () => {
    const page = readCode("src/app/page.tsx");
    expect(page).toMatch(/subscriptionId: params\.get\("subscription_id"\) \|\| undefined,/);
  });

  it("the TIER still comes from PayPal, never from the query string", () => {
    expect(shared).toMatch(/const tier = await tierForPaypalPlan\(sub\.planId\);/);
    expect(shared).toMatch(/intendedPlan/);
    // The client's hint is recorded and has no influence on the outcome.
    expect(shared).not.toMatch(/tier = .*intendedPlan/);
  });

  it("a non-entitling status is refused", () => {
    expect(shared).toMatch(/if \(!subscriptionEntitles\(sub\.status\)\)/);
  });

  it("ONE SUBSCRIPTION, ONE ACCOUNT - a second claimer is refused", () => {
    expect(shared).toMatch(/if \(owner && owner !== email\)/);
    expect(shared).toMatch(/belongs to another account/);
  });

  it("both checkout flows go through the SAME function", () => {
    // Two copies of "how a subscription becomes a plan" is how one of them ends
    // up subtly more permissive than the other.
    const button = readCode("src/app/api/subscriptions/paypal-success/route.ts");
    expect(button).toMatch(/confirmPaypalSubscription\(\{/);
    expect(button).not.toMatch(/tierForPaypalPlan/);
    expect(confirm).toMatch(/confirmPaypalSubscription/);
  });

  it("a failed verification reports PENDING, not an error - the webhook may land", () => {
    expect(confirm).toMatch(/return NextResponse\.json\(\{ ok: true, pending: true, reason: outcome\.error \}\);/);
  });
});

describe("REPRODUCTION: a webhook id that was only checked for being non-empty", () => {
  const keyTest = readCode("src/app/api/admin/key-test/route.ts");

  it("the id is verified against the app's real webhooks", () => {
    // A typo, a stale id, or a sandbox id in a live account all reported green -
    // and then every event failed signature verification and no plan was ever
    // granted.
    expect(keyTest).toMatch(/\/v1\/notifications\/webhooks/);
    expect(keyTest).toMatch(/!ids\.includes\(String\(webhookId\)\.trim\(\)\)/);
  });

  it("and the failure explains the consequence, not just the mismatch", () => {
    expect(keyTest).toMatch(/no plan will be granted/);
  });
});
