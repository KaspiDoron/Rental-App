import { describe, it, expect } from "vitest";
import {
  extractPriceNumbers,
  claimedRivalNumber,
  checkOutboundNumbers,
  hasHardConstraint,
  hardConstraintBreached,
  hardConstraintDecline,
  buildSafeBargainAsk,
} from "./guardrails";
import type { StructuredRFQ } from "../types";
import type { ExtractedOffer } from "../agents";

const manual125: StructuredRFQ = {
  vehicleClass: "motorbike",
  engineSizeCc: 125,
  transmission: "manual",
  durationDays: 4,
  accessories: [],
  fulfillment: "any",
  vendorMessage: "",
};

const money = (n: number, cur: string) => `${n} ${cur}`;

describe("extractPriceNumbers - a price is not a cc / a day / a time", () => {
  it("keeps prices, drops unit-tagged non-prices", () => {
    expect(extractPriceNumbers("125cc bike for 4 days, can you do 400?")).toEqual([400]);
    expect(extractPriceNumbers("45,000 km on it, price 500 a day")).toEqual([500]);
    expect(extractPriceNumbers("meet at 10:30, 300/day ok?")).toEqual([300]);
  });
  it("reads thousands separators as one number", () => {
    expect(extractPriceNumbers("1,200 per day")).toEqual([1200]);
    expect(extractPriceNumbers("1.200 baht")).toEqual([1200]);
  });
  it("honors the explicit exclude list (spec numbers)", () => {
    expect(extractPriceNumbers("125 bike 4 days do 400", [125, 4])).toEqual([400]);
  });
});

describe("claimedRivalNumber - detects an ASSERTED competitor price", () => {
  it("finds the fabricated 220 in the exact production message", () => {
    expect(
      claimedRivalNumber("another shop quoted 220, i'd book with you if you can do 200", [4])
    ).toBe(220);
  });
  it("ignores an honest comparison with no competitor number", () => {
    expect(claimedRivalNumber("i'm checking a few shops, can you do 400?")).toBeUndefined();
  });
  it("returns nothing when there is no rival phrase at all", () => {
    expect(claimedRivalNumber("your price is high, can you do 400?")).toBeUndefined();
  });
});

describe("checkOutboundNumbers - the three catastrophic failure classes", () => {
  // 4a) Baseline hallucination + sub-floor: "another shop quoted 220, ... do 200"
  //     with NO real rival and a 280 floor.
  it("BLOCKS the fabricated rival (220 invented, no rival exists)", () => {
    const r = checkOutboundNumbers({
      text: "another shop quoted 220, i'd book with you if you can do 200",
      floor: 280,
      ceiling: 1200,
      rivalPrice: undefined,
      excludeExact: [4],
      checkAskBounds: true,
    });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("fabricated-rival");
    expect(r.offending).toBe(220);
  });

  it("BLOCKS a sub-floor ask even without a rival claim (200 < 280)", () => {
    const r = checkOutboundNumbers({
      text: "can you please do 200 a day for me?",
      floor: 280,
      ceiling: 1200,
      excludeExact: [4],
      checkAskBounds: true,
    });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("below-floor");
    expect(r.offending).toBe(200);
  });

  // 4b) Inverted math: shop offered 500, agent asked for 600.
  it("BLOCKS an inverted ask above the shop's live price (600 > 500)", () => {
    const r = checkOutboundNumbers({
      text: "can u give me 600 per day for similar bike?",
      floor: 280,
      ceiling: 500,
      excludeExact: [4],
      checkAskBounds: true,
    });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("above-quote");
    expect(r.offending).toBe(600);
  });

  it("ALLOWS a sane ask inside [floor, quote] (400, floor 280, quote 500)", () => {
    const r = checkOutboundNumbers({
      text: "so sorry, 500 is expensive for me. i rent 4 days, can you do 400 my friend? 🙏",
      floor: 280,
      ceiling: 500,
      excludeExact: [4],
      checkAskBounds: true,
    });
    expect(r.ok).toBe(true);
  });

  it("ALLOWS mentioning a REAL rival at its true number", () => {
    const r = checkOutboundNumbers({
      text: "another shop already offered me 350, can you beat it? 🙂",
      floor: 280,
      ceiling: 500,
      rivalPrice: 350,
      excludeExact: [4],
      checkAskBounds: true,
    });
    expect(r.ok).toBe(true);
  });

  it("BLOCKS a rival claim that MISQUOTES the real rival (says 220, real is 350)", () => {
    const r = checkOutboundNumbers({
      text: "another shop offered me 220, can you match?",
      floor: 280,
      ceiling: 500,
      rivalPrice: 350,
      excludeExact: [4],
      checkAskBounds: true,
    });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("fabricated-rival");
  });

  it("does not flag spec numbers as prices (125cc / 4 days survive a 280 floor)", () => {
    const r = checkOutboundNumbers({
      text: "hi, the 125cc manual for 4 days - can you do 300 a day? 🙂",
      floor: 280,
      ceiling: 500,
      excludeExact: [125, 4],
      checkAskBounds: true,
    });
    expect(r.ok).toBe(true);
  });
});

describe("hard feature constraints - manual vs automatic is immutable", () => {
  const autoScooter500: ExtractedOffer = {
    found: true,
    pricePerDay: 500,
    currency: "PHP",
    matchesSpec: false, // the shop's vehicle is an automatic scooter, not the manual bike
    confidence: "high",
    vehicleDescription: "automatic scooter",
  };

  it("recognises a pinned transmission as a hard constraint", () => {
    expect(hasHardConstraint(manual125)).toBe(true);
    expect(hasHardConstraint({ ...manual125, transmission: "any" })).toBe(false);
  });

  it("flags a wrong-vehicle price as a hard-constraint breach", () => {
    expect(hardConstraintBreached(manual125, autoScooter500)).toBe(true);
  });

  it("does NOT flag a matching offer, or one with no price yet", () => {
    expect(hardConstraintBreached(manual125, { ...autoScooter500, matchesSpec: true })).toBe(false);
    expect(
      hardConstraintBreached(manual125, { ...autoScooter500, found: false, pricePerDay: undefined })
    ).toBe(false);
  });

  it("the decline restates the requirement and never names a price", () => {
    const msg = hardConstraintDecline(manual125);
    expect(msg.toLowerCase()).toContain("manual");
    expect(msg).toMatch(/125cc/);
    expect(extractPriceNumbers(msg, [125])).toEqual([]);
  });
});

describe("buildSafeBargainAsk - the graceful arithmetic-sane fallback", () => {
  it("builds an ask at the target when it is a genuine discount", () => {
    const msg = buildSafeBargainAsk({
      target: 400,
      ceiling: 500,
      floor: 280,
      durationDays: 4,
      currency: "PHP",
      money,
    });
    expect(msg).toContain("400 PHP");
    expect(msg).toContain("4 days");
  });
  it("refuses to build when the target is not below the quote, or below the floor", () => {
    expect(
      buildSafeBargainAsk({ target: 500, ceiling: 500, floor: 280, currency: "PHP", money })
    ).toBeNull();
    expect(
      buildSafeBargainAsk({ target: 200, ceiling: 500, floor: 280, currency: "PHP", money })
    ).toBeNull();
    expect(buildSafeBargainAsk({ target: undefined, currency: "PHP", money })).toBeNull();
  });
});
