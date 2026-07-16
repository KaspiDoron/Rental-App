import { describe, it, expect } from "vitest";
import { can, planFor, ENTITLEMENTS, FEATURE_META, type Feature } from "./entitlements";

describe("entitlements", () => {
  it("free users can compare but not mass-bargain", () => {
    expect(can("free", "compare")).toBe(true);
    expect(can("free", "mass-bargain")).toBe(false);
    expect(can("free", "local-language")).toBe(false);
  });

  it("pro unlocks mass bargain + scheduling but not ultra features", () => {
    expect(can("pro", "mass-bargain")).toBe(true);
    expect(can("pro", "future-scheduling")).toBe(true);
    expect(can("pro", "local-language")).toBe(false);
    expect(can("pro", "fast-responder-filter")).toBe(false);
  });

  it("ultra has everything", () => {
    for (const f of Object.keys(FEATURE_META) as Feature[]) {
      expect(can("ultra", f)).toBe(true);
    }
  });

  it("unknown/undefined plans behave as free (never crash, never over-grant)", () => {
    expect(can(undefined, "mass-bargain")).toBe(false);
    expect(can(null, "compare")).toBe(true);
    expect(can("business", "mass-bargain")).toBe(false); // raw legacy value is not a client plan id
    expect(can("hacker", "local-language")).toBe(false);
  });

  it("plans are supersets up the ladder (no pro perk missing from ultra)", () => {
    for (const f of ENTITLEMENTS.free) expect(ENTITLEMENTS.pro.has(f)).toBe(true);
    for (const f of ENTITLEMENTS.pro) expect(ENTITLEMENTS.ultra.has(f)).toBe(true);
  });

  it("every feature has meta and a sensible upsell target", () => {
    for (const f of Object.keys(FEATURE_META) as Feature[]) {
      expect(FEATURE_META[f].label.length).toBeGreaterThan(2);
      expect(["pro", "ultra"]).toContain(planFor(f));
      // The upsell plan must actually include the feature.
      expect(can(planFor(f), f)).toBe(true);
    }
  });
});
