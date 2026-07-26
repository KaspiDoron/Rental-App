import { describe, it, expect } from "vitest";
import { recheckMessage } from "./recheck-message";

// Coming back to a past hunt asks every shop one question. The number in that
// question is the SHOP'S OWN last quote - never one we made up.

describe("the re-check message", () => {
  it("reads the shop's own price back to them", () => {
    const m = recheckMessage({ pricePerDay: 400, currency: "PHP", days: 5 });
    expect(m).toContain("400");
    expect(m).toMatch(/5 days/);
    expect(m).toMatch(/still available/i);
  });

  it("invents no figure when the shop never gave one", () => {
    const m = recheckMessage({ pricePerDay: null, currency: "PHP", days: 5 });
    expect(m).not.toMatch(/\d+\/day/);
    expect(m).toMatch(/the rate we discussed/i);
  });

  it("says nothing about a duration we do not know", () => {
    expect(recheckMessage({ pricePerDay: 400, currency: "THB" })).not.toMatch(/for \d+ days/);
  });

  it("never treats a zero or negative price as a quote", () => {
    for (const p of [0, -1]) {
      expect(recheckMessage({ pricePerDay: p, currency: "PHP" })).toMatch(/rate we discussed/i);
    }
  });

  it("stays one short, human sentence", () => {
    const m = recheckMessage({ pricePerDay: 400, currency: "PHP", days: 5 });
    expect(m.length).toBeLessThan(140);
    expect(m.split(/[.!?]/).filter((s) => s.trim()).length).toBeLessThanOrEqual(2);
  });
});
