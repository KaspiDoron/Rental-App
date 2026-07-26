import { describe, it, expect } from "vitest";
import {
  menuUnresolved,
  mergeOptions,
  mileageIn,
  nextGap,
  optionsFromHits,
  signalsVariance,
  type VehicleOption,
} from "./offer-options";
import { extractQuotedPrices } from "./wa/price-extract";

// The exact Marlin Krabi thread that closed a live negotiation by mistake.
const KRABI = { vehicleClass: "scooter" as const, durationDays: 5, localCurrency: "THB" };

function optionsFor(text: string, depositNote?: string): VehicleOption[] {
  return optionsFromHits(extractQuotedPrices(text, KRABI).allOffers, { depositNote });
}

describe("a shop's reply is a menu, not a number", () => {
  it("reads BOTH tiers out of the live Marlin message", () => {
    const opts = optionsFor("Hi! Normal scooters? Some models 200 and some new 250/day");
    expect(opts.map((o) => o.pricePerDay)).toEqual([200, 250]);
    expect(opts[1].condition).toBe("new");
  });

  it("keeps the cheapest tier first so the traveller reads price", () => {
    const opts = optionsFor("new one 250/day, old one 200/day");
    expect(opts[0].pricePerDay).toBe(200);
    expect(opts[0].condition).toBe("older");
    expect(opts[1].condition).toBe("new");
  });

  it("flags what is still missing instead of guessing it", () => {
    const opts = optionsFor("Some models 200 and some new 250/day");
    expect(opts[0].gaps).toContain("mileage");
    expect(opts[0].gaps).toContain("photo");
    expect(nextGap(opts)).toBe("condition"); // the 200 tier is unlabeled
  });

  it("never invents a condition the shop did not state", () => {
    const opts = optionsFor("we have one at 200/day and one at 250/day");
    expect(opts.every((o) => o.condition === "unknown")).toBe(true);
    expect(opts.map((o) => o.label)).toEqual(["Cheaper option", "Pricier option"]);
  });

  it("a single price is NOT a menu", () => {
    expect(optionsFor("250/day for the scooter")).toEqual([]);
  });

  // The shop's SECOND message in the same live thread: it quotes the whole trip
  // instead of a daily rate, still as a choice.
  it("reads a trip-total menu over the real duration", () => {
    const opts = optionsFor("It depends on what you choose, 1000 or 1250 total\nDeposit 3000 or 100 USD/EUR");
    expect(opts.map((o) => o.pricePerDay)).toEqual([200, 250]); // /5 days
  });

  it("a model number is never mistaken for a second tier", () => {
    expect(optionsFor("the new one is a Click 125, 250/day")).toEqual([]);
    expect(optionsFor("we have 150cc and 125cc, 300/day")).toEqual([]);
  });

  it("picks up a model name and a stated mileage", () => {
    const opts = optionsFor("Click 125 at 250/day\nolder Wave 150 at 200/day, 40000 km");
    const older = opts.find((o) => o.pricePerDay === 200)!;
    expect(older.mileageKm).toBe(40000);
    expect(older.gaps).not.toContain("mileage");
    expect(opts.find((o) => o.pricePerDay === 250)!.model).toBe("Click 125");
  });

  it("carries the deposit through so it stops being a gap", () => {
    const opts = optionsFor("Some models 200 and some new 250/day", "3000 THB or 100 USD/EUR");
    expect(opts[0].depositNote).toBe("3000 THB or 100 USD/EUR");
    expect(opts[0].gaps).not.toContain("deposit");
  });
});

describe("mileageIn", () => {
  it("reads the shapes shops actually type", () => {
    expect(mileageIn("40000 km")).toBe(40000);
    expect(mileageIn("40,000 km")).toBe(40000);
    expect(mileageIn("40k km")).toBe(40000);
    expect(mileageIn("bike is clean")).toBeUndefined();
  });
});

describe("signalsVariance", () => {
  it("catches a menu even when no second number parsed", () => {
    expect(signalsVariance("It depends on what you choose, 1000 or 1250 total")).toBe(true);
    expect(signalsVariance("we have different models")).toBe(true);
    expect(signalsVariance("Some models 200 and some new 250/day")).toBe(true);
    expect(signalsVariance("250 per day, free delivery")).toBe(false);
  });
});

describe("mergeOptions - facts accumulate, never regress", () => {
  const first = optionsFor("Some models 200 and some new 250/day");

  it("a later turn enriches a tier instead of replacing it", () => {
    const later = optionsFor("the new one is a Click 125, 250/day. old one 200/day, 40000 km");
    const merged = mergeOptions(first, later);
    const older = merged.find((o) => o.pricePerDay === 200)!;
    expect(older.mileageKm).toBe(40000);
    expect(merged).toHaveLength(2);
  });

  it("a turn with no menu never erases the menu", () => {
    expect(mergeOptions(first, [])).toBe(first);
  });

  it("photos accumulate across turns without duplicating", () => {
    const withPhoto = first.map((o) => ({ ...o, photoRefs: ["a.jpg"] }));
    const merged = mergeOptions(withPhoto, first.map((o) => ({ ...o, photoRefs: ["a.jpg", "b.jpg"] })));
    expect(merged[0].photoRefs).toEqual(["a.jpg", "b.jpg"]);
    expect(merged[0].gaps).not.toContain("photo");
  });
});

describe("menuUnresolved - the predicate the policy rails key on", () => {
  it("is true while a tier is still missing something", () => {
    expect(menuUnresolved(optionsFor("Some models 200 and some new 250/day"))).toBe(true);
  });

  it("is false once every tier is fully known", () => {
    const complete = optionsFor("Some models 200 and some new 250/day").map((o) => ({
      ...o,
      condition: "new" as const,
      mileageKm: 12000,
      photoRefs: ["p.jpg"],
      depositNote: "3000 THB",
      gaps: [],
    }));
    expect(menuUnresolved(complete)).toBe(false);
    expect(nextGap(complete)).toBeNull();
  });

  it("a single option is never an unresolved menu", () => {
    expect(menuUnresolved([])).toBe(false);
  });
});
