import { describe, it, expect } from "vitest";
import { extractRentalDailyPrice } from "./price-extract";

// The exact Sun House Rental template that broke the parser in production: a
// business greeting, three port/airport transfer lines priced "/trip", the real
// scooter rental line "Scooter: 350 PHP/day", and an island-tour upsell.
const SUN_HOUSE = `Welcome to Sun House Rental! Here are our services:
Airport <-> Sun House Rental: 250 PHP/trip
Balbagon Port <-> Sun House Rental: 350 PHP/trip
Benoni Port <-> Sun House Rental: 600 PHP/trip
Scooter: 350 PHP/day
Island tour available, ask us for a quote!
Thank you and God bless.`;

describe("extractRentalDailyPrice - Sun House Rental (the production breaker)", () => {
  it("extracts the scooter /day rate and IGNORES the /trip transfer prices", () => {
    const hit = extractRentalDailyPrice(SUN_HOUSE, {
      vehicleClass: "scooter",
      durationDays: 5,
    });
    expect(hit).not.toBeNull();
    expect(hit!.pricePerDay).toBe(350);
    expect(hit!.currency).toBe("PHP");
    // NEVER the 250/350/600 "/trip" transfer numbers.
    expect(hit!.line.toLowerCase()).toContain("scooter");
    expect(hit!.line.toLowerCase()).not.toContain("trip");
  });

  it("does NOT grab the cheaper 250 airport-transfer number", () => {
    const hit = extractRentalDailyPrice(SUN_HOUSE, { vehicleClass: "scooter" });
    expect(hit!.pricePerDay).not.toBe(250);
    expect(hit!.pricePerDay).not.toBe(600);
  });

  it("classMatch is true for a scooter request against the 'Scooter:' line", () => {
    const hit = extractRentalDailyPrice(SUN_HOUSE, { vehicleClass: "scooter" });
    expect(hit!.classMatch).toBe(true);
  });
});

describe("extractRentalDailyPrice - currency in either position", () => {
  it("handles currency AFTER the number ('350 PHP/day')", () => {
    const hit = extractRentalDailyPrice("Scooter is 350 PHP/day", { vehicleClass: "scooter" });
    expect(hit!.pricePerDay).toBe(350);
    expect(hit!.currency).toBe("PHP");
  });

  it("handles currency BEFORE the number ('PHP 350 per day')", () => {
    const hit = extractRentalDailyPrice("PHP 350 per day for the scooter", { vehicleClass: "scooter" });
    expect(hit!.pricePerDay).toBe(350);
    expect(hit!.currency).toBe("PHP");
  });

  it("handles a bare number with a local-currency hint", () => {
    const hit = extractRentalDailyPrice("350 per day", { vehicleClass: "scooter", localCurrency: "PHP" });
    expect(hit!.pricePerDay).toBe(350);
    expect(hit!.currency).toBe("PHP");
  });

  it("handles the baht symbol ('฿300/day')", () => {
    const hit = extractRentalDailyPrice("฿300/day", { vehicleClass: "scooter" });
    expect(hit!.pricePerDay).toBe(300);
    expect(hit!.currency).toBe("THB");
  });
});

describe("extractRentalDailyPrice - class selection", () => {
  it("prefers the matching class line over a cheaper different-class line", () => {
    const text = `Car: 900/day\nScooter: 400/day\nMotorbike: 350/day`;
    const hit = extractRentalDailyPrice(text, { vehicleClass: "scooter" });
    expect(hit!.pricePerDay).toBe(400);
    expect(hit!.classMatch).toBe(true);
  });

  it("returns the cheapest among multiple matching-class lines", () => {
    const text = `Yamaha Fino scooter 280/day\nHonda Click scooter 300/day\nNMAX scooter 500/day`;
    const hit = extractRentalDailyPrice(text, { vehicleClass: "scooter" });
    expect(hit!.pricePerDay).toBe(280);
  });

  it("flags a wrong-class-only reply with classMatch false", () => {
    const hit = extractRentalDailyPrice("Sedan car 1200/day", { vehicleClass: "scooter" });
    expect(hit).not.toBeNull();
    expect(hit!.classMatch).toBe(false);
  });

  it("class-agnostic bare price ('350/day') matches any request", () => {
    const hit = extractRentalDailyPrice("It's 350/day", { vehicleClass: "scooter" });
    expect(hit!.pricePerDay).toBe(350);
    expect(hit!.classMatch).toBeUndefined();
  });
});

describe("extractRentalDailyPrice - totals and edge cases", () => {
  it("divides a whole-rental total ('1750 for 5 days')", () => {
    const hit = extractRentalDailyPrice("Scooter 1750 for 5 days", { vehicleClass: "scooter", durationDays: 5 });
    expect(hit!.pricePerDay).toBe(350);
  });

  it("does NOT mistake the day COUNT for a price ('3 day 900' -> 300, not 3)", () => {
    const hit = extractRentalDailyPrice("scooter 3 days 900", { vehicleClass: "scooter", durationDays: 3 });
    expect(hit!.pricePerDay).toBe(300);
  });

  it("returns null on a transfer-ONLY template (no rental line)", () => {
    const text = `Airport transfer: 250 PHP/trip\nPort transfer: 350 PHP/trip`;
    expect(extractRentalDailyPrice(text, { vehicleClass: "scooter" })).toBeNull();
  });

  it("returns null on a pure greeting", () => {
    expect(extractRentalDailyPrice("Hello sir! Welcome!", { vehicleClass: "scooter" })).toBeNull();
  });

  it("returns null on empty / whitespace", () => {
    expect(extractRentalDailyPrice("", {})).toBeNull();
    expect(extractRentalDailyPrice("   \n  ", {})).toBeNull();
  });

  it("handles a single-line reply with no newlines", () => {
    const hit = extractRentalDailyPrice("yes sir 350 php per day ok", { vehicleClass: "scooter" });
    expect(hit!.pricePerDay).toBe(350);
  });

  // ---- live-failure pins (the "3 of 4 offers vanished" formats) --------------

  it("MONTHLY quote on a 30-day search -> per-day over the real duration", () => {
    const hit = extractRentalDailyPrice("4000 baht per month", {
      vehicleClass: "scooter",
      durationDays: 30,
      localCurrency: "THB",
    });
    expect(hit!.pricePerDay).toBe(133); // 4000/30
    expect(hit!.currency).toBe("THB");
  });

  it("monthly phrased as 'monthly rate is 4500'", () => {
    const hit = extractRentalDailyPrice("monthly rate is 4500", { durationDays: 30 });
    expect(hit!.pricePerDay).toBe(150);
  });

  it("WEEKLY quote -> /7", () => {
    const hit = extractRentalDailyPrice("1400 a week sir", { durationDays: 7 });
    expect(hit!.pricePerDay).toBe(200);
  });

  it("BARE-NUMBER answer to our price question ('400 baht')", () => {
    const hit = extractRentalDailyPrice("400 baht", { durationDays: 30, localCurrency: "THB" });
    expect(hit!.pricePerDay).toBe(400);
  });

  it("bare plain number ('450')", () => {
    const hit = extractRentalDailyPrice("450", { durationDays: 4 });
    expect(hit!.pricePerDay).toBe(450);
  });

  it("bare number rejects times, tiny numbers and phone numbers", () => {
    expect(extractRentalDailyPrice("9", {})).toBeNull();
    expect(extractRentalDailyPrice("9:00", {})).toBeNull();
    expect(extractRentalDailyPrice("0812345678", {})).toBeNull();
    expect(extractRentalDailyPrice("we open at 9", {})).toBeNull();
  });

  it("k-notation ('150k per day' IDR)", () => {
    const hit = extractRentalDailyPrice("150k per day", { localCurrency: "IDR" });
    expect(hit!.pricePerDay).toBe(150000);
  });
});
