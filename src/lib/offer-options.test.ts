import { describe, it, expect } from "vitest";
import { ccIn, ccMatches, matchesSpec, menuUnresolved, mergeOptions, mileageIn, nextGap, offerForOption, optionsFromHits, optionsFromThread, signalsVariance, type VehicleOption } from "./offer-options";
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

// Locking the "older 200" tier must not book the headline "newer 250" price.
// Every downstream reader (BookingSheet, /api/bookings, the bargain draft) takes
// the price straight off the offer, so the choice has to be applied there.
describe("offerForOption - the chosen tier IS the price", () => {
  const offer = { pricePerDay: 250, currency: "THB", totalPrice: 1250, verified: true };
  const older = optionsFor("Some models 200 and some new 250/day")[0];

  it("rewrites price and total to the chosen tier", () => {
    const picked = offerForOption(offer, older, 5);
    expect(picked.pricePerDay).toBe(200);
    expect(picked.totalPrice).toBe(1000);
  });

  it("keeps every other field of the offer intact", () => {
    expect(offerForOption(offer, older, 5).verified).toBe(true);
  });

  it("never divides by zero on a missing duration", () => {
    expect(offerForOption(offer, older, 0).totalPrice).toBe(200);
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

// ---------------------------------------------------------------------------
// CEE MOTO SIARGAO, 26 Jul - the shop answered a 125cc scooter request with its
// ENTIRE price board, and the card offered all seventeen rows as things to pick,
// including a 4-peso "option" read out of a Google Maps link.
// ---------------------------------------------------------------------------
const CEE_MOTO = `Thank you for contacting Ceemoto Rentals Siargao! Please let us know how we can help you.
Waze & GoogleMap: https://maps.app.goo.gl/FRqAc4day2rY4mF49?g_st=ic
Please make a reservation before visiting our shop, as units sell out quickly.

Standard Rates:
>>P350/day - 110cc Honda Beat, Mio Gear, Mio i
>>P500/day - 125cc Honda Click, Fazzio
>>P450/day- 110cc Bike with Surf Rack
>>P600/day - Honda Click 150cc
>>P900/day - Scrambler/Classic build
>>P1,200/day - Honda XR 200cc
>>P1,300/day - Scrambler/Classic build 250cc

Discounted Rates for Rentals of 8 Days or More:
>>P330/day - 110cc Honda Beat, Mio Gear, Mio i
>>P400/day- 110cc Bike with Surf Rack
>>P450/day - 125cc Honda Click , Fazzio
>>P550/day - Honda 150cc(Keyless)
>>P800/day - Scrambler/Classic build
>>P1,100/day - Honda XR 200cc
>>P1,200/day - Scrambler/Classic build 250cc

We offer Pickup or Delivery for 50pesos service fee around General Luna.`;

describe("a price board is scoped to the vehicle the traveller declared", () => {
  const SPEC = { vehicleClass: "scooter" as const, engineSizeCc: 125, transmission: "automatic" as const };

  it("keeps ONLY the 125cc rows - not the whole board", () => {
    const opts = optionsFromThread([CEE_MOTO], { ...SPEC, durationDays: 5 });
    const prices = opts.map((o) => o.pricePerDay).sort((a, b) => a - b);
    // P450 (8+ days) and P500 (standard) are the two 125cc Click/Fazzio rates.
    expect(prices).toEqual([450, 500]);
  });

  it("drops every off-spec class - the traveller is not licensed for them", () => {
    const opts = optionsFromThread([CEE_MOTO], { ...SPEC, durationDays: 5 });
    const all = opts.map((o) => o.pricePerDay);
    for (const off of [350, 330, 450 /* surf rack is 110cc */, 600, 550, 900, 800, 1200, 1100, 1300]) {
      if (off === 450) continue; // 450 is legitimately the 125cc 8-day rate
      expect(all).not.toContain(off);
    }
    // The 200cc XR and the 250cc Scrambler are the ones that matter most.
    expect(all).not.toContain(1200);
    expect(all).not.toContain(1300);
  });

  it("never reads a price out of a URL (the 4-peso scooter)", () => {
    const opts = optionsFromThread([CEE_MOTO], { ...SPEC, durationDays: 5 });
    expect(opts.map((o) => o.pricePerDay)).not.toContain(4);
  });

  it("never reads a qualifying duration as a rate (the 8-peso scooter)", () => {
    const opts = optionsFromThread([CEE_MOTO], { ...SPEC, durationDays: 5 });
    expect(opts.map((o) => o.pricePerDay)).not.toContain(8);
  });

  it("with NO declared spec the behaviour is unchanged - nothing is dropped blindly", () => {
    const opts = optionsFromThread([CEE_MOTO], { durationDays: 5 });
    expect(opts.length).toBeGreaterThan(2);
  });
});

describe("spec matching is judged on the shop's words, never the price", () => {
  const SCOOTER125 = { vehicleClass: "scooter" as const, engineSizeCc: 125 };

  it("reads a displacement in every form a shop types it", () => {
    expect(ccIn("125cc Honda Click")).toBe(125);
    expect(ccIn("Honda Click 150cc")).toBe(150);
    expect(ccIn("Honda XR 200")).toBe(200);
    expect(ccIn(">>P350/day - 110cc Honda Beat")).toBe(110);
    // A price is not a displacement.
    expect(ccIn("350 per day")).toBeUndefined();
  });

  it("a 125 badge tolerates manufacturer rounding but not the next size up", () => {
    expect(ccMatches(125, 125)).toBe(true);
    expect(ccMatches(125, 124)).toBe(true);
    expect(ccMatches(125, 110)).toBe(false);
    expect(ccMatches(125, 150)).toBe(false);
  });

  it("keeps a line that names nothing - most likely the answer we asked for", () => {
    expect(matchesSpec("400 per day", SCOOTER125)).toBe(true);
    expect(matchesSpec("best price 380/day for you", SCOOTER125)).toBe(true);
  });

  it("drops a manual bike on an automatic request even with no displacement", () => {
    expect(
      matchesSpec("Scrambler/Classic build", { ...SCOOTER125, transmission: "automatic" })
    ).toBe(false);
  });

  it("keeps the right scooter", () => {
    expect(matchesSpec("125cc Honda Click, Fazzio", SCOOTER125)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A PRICE BOARD IS A LADDER UNDER A HEADING (Siargao, 26 Jul).
//
// The shop sent two photo boards. The agent quoted the 155cc board's 15-29 day
// rate to a traveller staying five days who had asked for a 125cc scooter.
// ---------------------------------------------------------------------------

const BOARD_155 = `155 CC
1-2 days - P 650
3-7 days - P 600
8-14 days - P 550
15-29 days - P 500
Monthly - P 450`;

const BOARD_CLICK = `Honda Click - V2 125 CC
1 day - P 450
2-10 days - P 400
11-20 days - P 350
21-29 days - P 300
Monthly - P 250`;

describe("a board is scoped by its heading and by the traveller's dates", () => {
  it("drops a 155cc board entirely for a 125cc traveller", () => {
    const opts = optionsFromThread([BOARD_155], {
      vehicleClass: "scooter",
      engineSizeCc: 125,
      durationDays: 5,
    });
    expect(opts).toHaveLength(0);
  });

  it("keeps the 125cc board and labels each row with its own stay", () => {
    const opts = optionsFromThread([BOARD_CLICK], {
      vehicleClass: "scooter",
      engineSizeCc: 125,
      durationDays: 5,
    });
    expect(opts.map((o) => o.pricePerDay)).toEqual([250, 300, 350, 400, 450]);
    const five = opts.find((o) => o.pricePerDay === 400);
    expect(five?.minDays).toBe(2);
    expect(five?.maxDays).toBe(10);
    expect(five?.tierLabel).toMatch(/2-10\s*days/i);
  });

  it("never turns a board row into an 86-a-day whole-rental total", () => {
    const opts = optionsFromThread([BOARD_CLICK], { engineSizeCc: 125, durationDays: 5 });
    expect(opts.every((o) => o.pricePerDay >= 250)).toBe(true);
  });

  it("a heading that names its own row does not govern the rest", () => {
    // "Click 125 - 400/day" describes itself; the 200cc line below must not
    // inherit it and sneak past the spec gate.
    const opts = optionsFromThread(["Click 125 - 400/day\nXR 200cc - 900/day"], {
      vehicleClass: "scooter",
      engineSizeCc: 125,
    });
    expect(opts.map((o) => o.pricePerDay)).not.toContain(900);
  });
});
