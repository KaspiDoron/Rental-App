import { describe, it, expect } from "vitest";
import { isPresentableOffer, cheapestPresentable, vehicleStance } from "./offer-presentation";
import { readFileSync } from "fs";
import { join } from "path";

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

// ---------------------------------------------------------------------------
// THE STANCE. Two states, one bit, and the surface guessed the accusation.
// ---------------------------------------------------------------------------

describe("what we may say out loud about a quote's vehicle", () => {
  it("only a POSITIVE identification is an accusation", () => {
    expect(vehicleStance({ pricePerDay: 250, currency: "THB", vehicleStatus: "wrong-vehicle" })).toBe(
      "mismatch"
    );
  });

  it("an unresolved gate is 'confirming', never 'different vehicle'", () => {
    // The 27 Jul Chiang Mai shop: it quoted the exact 125cc asked for, the gate
    // said needs-confirmation, and the card called it a different vehicle.
    expect(
      vehicleStance({ pricePerDay: 250, currency: "THB", vehicleStatus: "needs-confirmation" })
    ).toBe("confirming");
  });

  it("a bare matchesSpec:false cannot tell the two apart, so it accuses nobody", () => {
    expect(vehicleStance({ pricePerDay: 250, currency: "THB", matchesSpec: false })).toBe(
      "confirming"
    );
  });

  it("a confirmed vehicle, or no signal at all, is just fine", () => {
    expect(vehicleStance({ pricePerDay: 250, currency: "THB", vehicleStatus: "confirmed" })).toBe("ok");
    expect(vehicleStance({ pricePerDay: 250, currency: "THB" })).toBe("ok");
    expect(vehicleStance(null)).toBe("ok");
  });

  it("the gate still outranks the boolean when they disagree", () => {
    expect(
      vehicleStance({
        pricePerDay: 250,
        currency: "THB",
        matchesSpec: true,
        vehicleStatus: "wrong-vehicle",
      })
    ).toBe("mismatch");
    expect(
      vehicleStance({
        pricePerDay: 250,
        currency: "THB",
        matchesSpec: false,
        vehicleStatus: "confirmed",
      })
    ).toBe("ok");
  });

  it("the card reads the stance, not the bit, in every branch", () => {
    const card = readFileSync(join(process.cwd(), "src/components/VendorCard.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(card).toMatch(/const stance = vehicleStance\(offer\)/);
    expect(card).not.toMatch(/offer\.matchesSpec === false \?/);
  });
});
