import { describe, it, expect } from "vitest";
import { isPresentableOffer, cheapestPresentable } from "./offer-presentation";

// Pins the invariant the owner reported broken: a cheaper price the shop quoted
// for a DIFFERENT vehicle (matchesSpec === false - the e-bike) must NEVER be
// picked as the traveller's best/lockable deal.

describe("isPresentableOffer", () => {
  it("rejects an off-spec quote", () => {
    expect(isPresentableOffer({ pricePerDay: 200, currency: "THB", matchesSpec: false })).toBe(false);
  });
  it("accepts a matching quote (confirmed or not)", () => {
    expect(isPresentableOffer({ pricePerDay: 300, currency: "THB", matchesSpec: true })).toBe(true);
  });
  it("treats legacy rows (no matchesSpec) as matching", () => {
    expect(isPresentableOffer({ pricePerDay: 300, currency: "THB" })).toBe(true);
  });
  it("rejects a missing offer", () => {
    expect(isPresentableOffer(undefined)).toBe(false);
    expect(isPresentableOffer(null)).toBe(false);
  });
});

describe("cheapestPresentable", () => {
  const dom = "THB";
  it("never returns a cheaper off-spec offer over a pricier matching one", () => {
    const vendors = [
      { id: "ebike", offer: { pricePerDay: 200, currency: "THB", matchesSpec: false } },
      { id: "scooter", offer: { pricePerDay: 300, currency: "THB", matchesSpec: true } },
    ];
    expect(cheapestPresentable(vendors, dom)?.id).toBe("scooter");
  });

  it("picks the cheapest among matching offers", () => {
    const vendors = [
      { id: "a", offer: { pricePerDay: 350, currency: "THB", matchesSpec: true } },
      { id: "b", offer: { pricePerDay: 300, currency: "THB", matchesSpec: true } },
      { id: "c", offer: { pricePerDay: 200, currency: "THB", matchesSpec: false } },
    ];
    expect(cheapestPresentable(vendors, dom)?.id).toBe("b");
  });

  it("ignores offers in a non-dominant currency", () => {
    const vendors = [
      { id: "usd", offer: { pricePerDay: 5, currency: "USD", matchesSpec: true } },
      { id: "thb", offer: { pricePerDay: 300, currency: "THB", matchesSpec: true } },
    ];
    expect(cheapestPresentable(vendors, dom)?.id).toBe("thb");
  });

  it("returns undefined when every offer is off-spec", () => {
    const vendors = [
      { id: "a", offer: { pricePerDay: 200, currency: "THB", matchesSpec: false } },
    ];
    expect(cheapestPresentable(vendors, dom)).toBeUndefined();
  });
});
