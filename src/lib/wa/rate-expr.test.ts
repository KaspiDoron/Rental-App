import { describe, it, expect } from "vitest";
import { scanRates, UNIT_DAYS } from "./rate-expr";
import { extractQuotedPrices, extractRentalDailyPrice } from "./price-extract";
import { plausibleDaily, sanePrice, IMPLAUSIBLE_RATIO } from "./price-sanity";

// The live failure, verbatim from the 27 Jul Chiang Mai thread.
const CAPTION = "Click 125cc 6 days discount 250/1day";

describe("a rate has a denominator", () => {
  it("reads 250/1day as 250 per day, not 1", () => {
    // The whole reason this module exists. Every pattern before it was shaped
    // `amount ... "day"`, so the ONE - the quantity - was read as the money.
    const [r] = scanRates(CAPTION);
    expect(r.amount).toBe(250);
    expect(r.quantity).toBe(1);
    expect(r.perDay).toBe(250);
  });

  it("divides a multi-day denominator", () => {
    expect(scanRates("3000/7days")[0].perDay).toBe(429);
    expect(scanRates("4500 per 30 days")[0].perDay).toBe(150);
    expect(scanRates("1750 5 days")[0].perDay).toBe(350);
  });

  it("still reads the ordinary forms every shop uses", () => {
    expect(scanRates("Scooter: 350 PHP/day")[0].perDay).toBe(350);
    expect(scanRates("400 baht per day")[0].perDay).toBe(400);
    expect(scanRates("HONDA CLICK 125 CC 300.-/DAY")[0].perDay).toBe(300);
    expect(scanRates("฿280 a day")[0].perDay).toBe(280);
  });

  it("converts week and month against the same algebra", () => {
    expect(UNIT_DAYS).toEqual({ day: 1, week: 7, month: 30 });
    expect(scanRates("1500 a week")[0].perDay).toBe(214);
    expect(scanRates("4000 per month")[0].perDay).toBe(133);
  });

  it("a DURATION is not a rate - the other half of the same bug", () => {
    // No currency, no separator, no quantity. "6 days" in the caption above is
    // the stay, and reading it as 6/day is how a duration became an offer.
    expect(scanRates("minimum 3 days")).toHaveLength(0);
    expect(scanRates("we are open 7 days")).toHaveLength(0);
    expect(scanRates("rentals of 8 days or more")).toHaveLength(0);
    // ...and in the real caption only the true rate survives.
    expect(scanRates(CAPTION).map((r) => r.perDay)).toEqual([250]);
  });

  it("keeps both amounts when a shop states an anchor and an offer", () => {
    expect(scanRates("Normally 300/day but for you 250/day").map((r) => r.perDay)).toEqual([
      300, 250,
    ]);
  });

  it("a model number is never a rate", () => {
    expect(scanRates("Honda Click 125cc available")).toHaveLength(0);
  });

  it("GLOBAL, NOT LOCALE: an unknown short tail glued to the amount is currency evidence", () => {
    // The Thailand field test, verbatim: "b." is Thai baht shorthand and was
    // in no list - and the next market will write "rs" or "fr". Structure is
    // the signal; no country string list is load-bearing.
    expect(scanRates("Honda click 125cc 1200b./6days")[0].perDay).toBe(200);
    expect(scanRates("Honda click 125cc 1100b./6days")[0].perDay).toBe(183);
    expect(scanRates("500rs/2days")[0].perDay).toBe(250);
    expect(scanRates("700fr/day")[0].perDay).toBe(700);
  });

  it("...but reserved units and measures never masquerade as currency", () => {
    // A km allowance is not a price; a clock time is not a rate.
    expect(scanRates("100km/day free")).toHaveLength(0);
    expect(scanRates("open 9 am - 7 pm daily")).toHaveLength(0);
  });

  it("THE FIELD MISDIVISION SHAPE: a marked daily beside a stay count stays a daily", () => {
    // "6 days 180 per day" - the day count is the STAY, the marked rate is
    // the price. Reading 180/6=30 put ฿30/day on a real traveller's card.
    const rates = scanRates("6 days 180 per day");
    expect(rates.map((r) => r.perDay)).toEqual([180]);
  });

  it("reports where the money sits, so callers can read around it", () => {
    const [r] = scanRates(CAPTION);
    expect(CAPTION.slice(r.index, r.index + 3)).toBe("250");
    expect(r.hasQuantity).toBe(true);
    expect(scanRates("350 THB/day")[0].hasCurrency).toBe(true);
  });
});

describe("the extractor as a whole, on the message that broke it", () => {
  const KRABI = { vehicleClass: "scooter" as const, durationDays: 6, localCurrency: "THB" };

  it("quotes 250, and never 1", () => {
    const hit = extractRentalDailyPrice(CAPTION, KRABI);
    expect(hit?.pricePerDay).toBe(250);
  });

  it("does not smuggle the 1 in as a second option either", () => {
    const { allOffers } = extractQuotedPrices(CAPTION, KRABI);
    expect(allOffers.map((o) => o.pricePerDay)).not.toContain(1);
    expect(allOffers.map((o) => o.pricePerDay)).toContain(250);
  });

  it("the shop's own vehicle word still scopes the line", () => {
    // "Click" is a scooter nameplate - the line matches the traveller's class,
    // which is what stops it being filed as somebody else's vehicle.
    const hit = extractRentalDailyPrice(CAPTION, KRABI);
    expect(hit?.classMatch).toBe(true);
  });
});

describe("a price has to be believable", () => {
  const BAND = { floor: 250, typical: 350 };

  it("a fifth of the regional floor is a misread, not a discount", () => {
    expect(plausibleDaily(1, BAND)).toBe(false);
    // DELIBERATE REWRITE: the bound is STRICT now. Thailand's ฿30/day (180/6)
    // passed only because floor 150 * 0.2 landed EXACTLY on 30 and the old
    // comparison was inclusive - a boundary coincidence must never decide
    // that a price is real.
    expect(plausibleDaily(250 * IMPLAUSIBLE_RATIO, BAND)).toBe(false);
    expect(plausibleDaily(250 * IMPLAUSIBLE_RATIO + 1, BAND)).toBe(true);
    expect(plausibleDaily(200, BAND)).toBe(true); // shops DO undercut the seed
  });

  it("THE FIELD CASE: 180/6 = 30 is repaired to the 180 the shop actually wrote", () => {
    const THAI = { floor: 150, typical: 240 };
    const v = sanePrice(30, [30, 180], THAI, { durationDays: 6 });
    expect(v.pricePerDay).toBe(180);
    expect(v.corrected).toBe(true);
    expect(v.reason).toMatch(/reconstructs 180/);
  });

  it("with no floor data nothing is second-guessed", () => {
    expect(plausibleDaily(1, null)).toBe(true);
    expect(plausibleDaily(1, { floor: 0 })).toBe(true);
  });

  it("recovers the real number from the SAME message", () => {
    const v = sanePrice(1, [1, 250], BAND);
    expect(v.pricePerDay).toBe(250);
    expect(v.corrected).toBe(true);
    expect(v.reason).toMatch(/250/);
  });

  it("prefers the cheapest BELIEVABLE candidate, not the cheapest", () => {
    expect(sanePrice(1, [1, 2, 300, 400], BAND).pricePerDay).toBe(300);
  });

  it("no believable number means NO price - never a number nobody said", () => {
    const v = sanePrice(1, [1, 2], BAND);
    expect(v.pricePerDay).toBeNull();
    expect(v.corrected).toBe(true);
    expect(v.reason).toMatch(/no price yet/i);
  });

  it("a believable price is passed through untouched", () => {
    expect(sanePrice(250, [250, 300], BAND)).toEqual({ pricePerDay: 250, corrected: false });
  });
});

// ---------------------------------------------------------------------------
// THE WIRING.
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";
import { join } from "path";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("both nets are actually in the pipeline", () => {
  it("the extractor reads rates through the algebra, not a flat day pattern", () => {
    const p = readCode("src/lib/wa/price-extract.ts");
    expect(p).toMatch(/scanRates\(line\)/);
    expect(p).not.toMatch(/const PRICE_DAY_G/);
  });

  it("the reply loop refuses an implausible price and says so", () => {
    const a = readCode("src/lib/agent-loop.ts");
    expect(a).toMatch(/sanePrice\(usablePrice, others, floorSameCur, \{/);
    expect(a).toMatch(/durationDays: rfq\.durationDays/);
    expect(a).toMatch(/price-implausible/);
  });

  it("the two engines RECONCILE - an LLM read is always cross-checked", () => {
    const a = readCode("src/lib/agent-loop.ts");
    expect(a).toMatch(/price-reconciled/);
    expect(a).toMatch(/arbitratePriceBasis/);
    // The arbiter may only PICK between grounded candidates, never invent.
    expect(readCode("src/lib/agents.ts")).toMatch(/MUST be one of the two readings/);
  });
});
