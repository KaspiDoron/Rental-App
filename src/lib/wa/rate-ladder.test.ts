import { describe, it, expect } from "vitest";
import { parseRateLadder, tierForDays, ladderRateFor, rangeOf } from "./rate-ladder";

// The two boards the shop actually sent on 26 Jul, typed out verbatim from the
// photos. The traveller asked for a 125cc scooter for FIVE days.

const BOARD_155 = `
  155 CC
  • 1-2 days   - ₱ 650
  • 3-7 days   - ₱ 600
  • 8-14 days  - ₱ 550
  • 15-29 days - ₱ 500
  • Monthly    - ₱ 450
  Well Maintained
  Complete Papers
  Free Helmets (Maximum 2)
  Requirements: Driver's License, Passport/Valid ID or Cash
`;

const BOARD_CLICK_125 = `
  Honda Click - V2   125 CC
  • 1 day       - ₱ 450
  • 2-10 days   - ₱ 400
  • 11-20 days  - ₱ 350
  • 21-29 days  - ₱ 300
  • Monthly     - ₱ 250
`;

describe("the board the agent misread", () => {
  it("reads all five tiers off the 155cc board", () => {
    const tiers = parseRateLadder(BOARD_155);
    expect(tiers.map((t) => t.pricePerDay)).toEqual([650, 600, 550, 500, 450]);
    expect(tiers.every((t) => t.unit === "per-day")).toBe(true);
  });

  it("quotes 600 for a 5-day stay - NOT the 500 it actually sent", () => {
    const r = ladderRateFor(BOARD_155, 5);
    expect(r?.pricePerDay).toBe(600);
    expect(r?.tier.label.replace(/\s+/g, "")).toMatch(/3-7days/i);
  });

  it("quotes 400 for a 5-day stay on the Click 125 board", () => {
    const r = ladderRateFor(BOARD_CLICK_125, 5);
    expect(r?.pricePerDay).toBe(400);
  });

  it("never mistakes a row for a whole-rental total", () => {
    // "3-7 days - 600" used to be read as 600 over 7 days = 86/day.
    const tiers = parseRateLadder(BOARD_155);
    expect(tiers.some((t) => t.pricePerDay < 100)).toBe(false);
  });

  it("keeps the shop's currency", () => {
    expect(parseRateLadder(BOARD_155)[0].currency).toBe("PHP");
  });

  it("skips the requirements block - a licence line is not a price tier", () => {
    const tiers = parseRateLadder(BOARD_155);
    expect(tiers.every((t) => !/licen/i.test(t.line))).toBe(true);
  });
});

describe("picking the right row", () => {
  const tiers = parseRateLadder(BOARD_CLICK_125);

  it("1 day takes the 1-day row", () => {
    expect(tierForDays(tiers, 1)?.pricePerDay).toBe(450);
  });
  it("10 days is still the 2-10 row - the boundary is inclusive", () => {
    expect(tierForDays(tiers, 10)?.pricePerDay).toBe(400);
  });
  it("11 days crosses into the next row", () => {
    expect(tierForDays(tiers, 11)?.pricePerDay).toBe(350);
  });
  it("60 days rides the open-ended monthly row", () => {
    expect(tierForDays(tiers, 60)?.pricePerDay).toBe(250);
  });
  it("a stay below the whole board takes the NEAREST row, never the cheapest", () => {
    const sparse = parseRateLadder("3-7 days 600\n8-14 days 550\nMonthly 450");
    expect(tierForDays(sparse, 1)?.pricePerDay).toBe(600);
  });
});

describe("boards written as period TOTALS", () => {
  // Same structure, opposite direction: the number grows with the stay, so each
  // row is the whole-period price.
  const TOTALS = `
    1 day - 500
    3 days - 1350
    7 days - 2800
    30 days - 9000
  `;

  it("recognises them by direction and converts to a daily rate", () => {
    const tiers = parseRateLadder(TOTALS);
    expect(tiers.every((t) => t.unit === "total")).toBe(true);
    expect(tiers[0].pricePerDay).toBe(500);
    expect(tiers[1].pricePerDay).toBe(450); // 1350 / 3
    expect(tiers[2].pricePerDay).toBe(400); // 2800 / 7
  });

  it("a 3-day stay pays the 3-day row's daily equivalent", () => {
    expect(ladderRateFor(TOTALS, 3)?.pricePerDay).toBe(450);
  });
});

describe("what is NOT a ladder", () => {
  it("one row alone is left to the ordinary readers", () => {
    expect(parseRateLadder("5 days 1750")).toEqual([]);
  });

  it("a chatty reply with no durations yields nothing", () => {
    expect(parseRateLadder("Hello! Yes we have Honda Click 125cc available today.")).toEqual([]);
  });

  it("the same duration restated twice is not two tiers", () => {
    expect(parseRateLadder("7 days - 600\n7 days - 600")).toEqual([]);
  });

  it("ladderRateFor returns null rather than guessing", () => {
    expect(ladderRateFor("best price 400 per day", 5)).toBeNull();
  });
});

describe("range reading", () => {
  it("handles dashes, en dashes and 'to'", () => {
    expect(rangeOf("3-7 days")).toMatchObject({ minDays: 3, maxDays: 7 });
    expect(rangeOf("3 – 7 days")).toMatchObject({ minDays: 3, maxDays: 7 });
    expect(rangeOf("3 to 7 days")).toMatchObject({ minDays: 3, maxDays: 7 });
    expect(rangeOf("15-29days")).toMatchObject({ minDays: 15, maxDays: 29 });
  });

  it("open-ended rows never cap", () => {
    expect(rangeOf("8 days or more")?.maxDays).toBe(Infinity);
    expect(rangeOf("Monthly")).toMatchObject({ minDays: 30, maxDays: Infinity });
  });

  it("a line with no duration is not a row", () => {
    expect(rangeOf("Free Helmets (Maximum 2)")).toBeNull();
  });
});
