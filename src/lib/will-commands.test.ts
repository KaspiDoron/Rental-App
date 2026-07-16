import { describe, it, expect } from "vitest";
import {
  parseWillCommandDeterministic,
  clampRadius,
  topVendors,
  type WillContext,
} from "./will-commands";

const ctx = (over: Partial<WillContext> = {}): WillContext => ({
  phase: "done",
  radiusKm: 8,
  vendors: [
    { id: "a", name: "Moto Rent Canggu", pricePerDay: 180, currency: "THB" },
    { id: "b", name: "Jaya Rentals", pricePerDay: 160, currency: "THB" },
    { id: "c", name: "Beach Scooters" },
  ],
  offersIn: 2,
  waConnected: true,
  plan: "pro",
  paused: false,
  notes: [],
  ...over,
});

describe("will deterministic parser", () => {
  it("radius: explicit km", () => {
    expect(parseWillCommandDeterministic("Expand search radius to 5km", ctx())).toEqual({
      action: "set_radius",
      km: 5,
    });
    expect(parseWillCommandDeterministic("radius 12", ctx())).toEqual({
      action: "set_radius",
      km: 12,
    });
  });

  it("radius: 'search wider' bumps by 5, clamped", () => {
    expect(parseWillCommandDeterministic("search a wider area please", ctx())).toEqual({
      action: "set_radius",
      km: 13,
    });
    expect(clampRadius(99)).toBe(25);
    expect(clampRadius(0)).toBe(2);
  });

  it("budget: under X / clear budget", () => {
    expect(
      parseWillCommandDeterministic("show me only options under $10/day", ctx())
    ).toEqual({ action: "set_budget", maxPricePerDay: 10 });
    expect(parseWillCommandDeterministic("remove the budget cap", ctx())).toEqual({
      action: "set_budget",
      maxPricePerDay: null,
    });
  });

  it("vehicle class: only automatic scooters", () => {
    const c = parseWillCommandDeterministic("Only show automatic scooters", ctx());
    expect(c).toMatchObject({ action: "set_filter", patch: { vehicleClass: "scooter" } });
  });

  it("pause / resume / mass bargain", () => {
    expect(parseWillCommandDeterministic("pause this search", ctx())).toEqual({
      action: "pause_session",
    });
    expect(parseWillCommandDeterministic("ok continue searching", ctx())).toEqual({
      action: "resume_session",
    });
    expect(parseWillCommandDeterministic("try negotiating harder", ctx())).toEqual({
      action: "mass_bargain",
    });
  });

  it("compare picks the cheapest-first top N ids", () => {
    const c = parseWillCommandDeterministic("compare the top 3 options", ctx());
    expect(c).toMatchObject({ action: "compare" });
    if (c?.action === "compare") {
      expect(c.vendorIds[0]).toBe("b"); // 160 beats 180
      expect(c.vendorIds).toHaveLength(3);
    }
  });

  it("status and why route to server-composed answers", () => {
    expect(parseWillCommandDeterministic("What are you doing right now?", ctx())).toEqual({
      action: "answer",
      text: "__STATUS__",
    });
    expect(
      parseWillCommandDeterministic("Why was this rental selected?", ctx())
    ).toEqual({ action: "answer", text: "__WHY__" });
  });

  it("remember stores a standing instruction", () => {
    const c = parseWillCommandDeterministic(
      "Remember: I never want shops that demand my passport",
      ctx()
    );
    expect(c).toMatchObject({ action: "remember" });
  });

  it("gibberish returns null (LLM or clarify territory)", () => {
    expect(parseWillCommandDeterministic("banana wharf indigo", ctx())).toBeNull();
  });

  it("topVendors sorts priced-cheapest first", () => {
    expect(topVendors(ctx(), 2).map((v) => v.id)).toEqual(["b", "a"]);
  });
});
