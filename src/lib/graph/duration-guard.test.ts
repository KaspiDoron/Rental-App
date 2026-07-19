import { describe, it, expect } from "vitest";
import {
  correctDuration,
  citedDurationDays,
  checkOutboundNumbers,
  stripRivalClaims,
} from "./guardrails";

// The exact production failure (real WhatsApp, screenshots IMG_8480):
// traveller searched 5 DAYS, opener said "5 days", but the counter said
// "For 3 days tho, another shop quoted 220. i'd book with you if you can do 200".
describe("correctDuration - the 5->3 hallucination (BUG 1)", () => {
  it("rewrites the wrong day count to the traveller's real duration", () => {
    const r = correctDuration("For 3 days tho, another shop quoted 220. can you do 200?", 5);
    expect(r.changed).toBe(true);
    expect(r.from).toContain(3);
    expect(r.text).toContain("5 days");
    expect(r.text).not.toMatch(/\b3 days?\b/);
  });

  it("fixes the short 'answer' reply too ('3 days. deposit?' -> '5 days. deposit?')", () => {
    const r = correctDuration("3 days. deposit?", 5);
    expect(r.text).toBe("5 days. deposit?");
  });

  it("leaves a CORRECT duration untouched", () => {
    const r = correctDuration("I rent for 5 days, can you do 200 a day?", 5);
    expect(r.changed).toBe(false);
    expect(r.text).toBe("I rent for 5 days, can you do 200 a day?");
  });

  it("handles the hyphenated '3-day rental' form", () => {
    const r = correctDuration("For the 3-day rental, best price?", 5);
    expect(r.text).toContain("5 days");
    expect(r.text).not.toContain("3-day");
  });

  it("normalises weeks: a '1 week' mention when the rental is 5 days is corrected", () => {
    const r = correctDuration("I need it 1 week", 5);
    expect(r.text).toContain("5 days");
  });

  it("keeps a matching weekly mention (14-day rental, '2 weeks')", () => {
    const r = correctDuration("renting 2 weeks", 14);
    expect(r.changed).toBe(false);
  });

  it("never touches a per-day PRICE ('250 per day') - no digit before 'day'", () => {
    const r = correctDuration("ok 250 per day is fine", 5);
    expect(r.changed).toBe(false);
    expect(r.text).toBe("ok 250 per day is fine");
  });

  it("ignores an implausible day count outside 1..90", () => {
    const r = correctDuration("open 365 days a year", 5);
    expect(r.changed).toBe(false);
  });

  it("is a no-op when durationDays is unknown", () => {
    expect(correctDuration("for 3 days", undefined).changed).toBe(false);
  });

  it("citedDurationDays reports the rental lengths a message names", () => {
    expect(citedDurationDays("3 days")).toEqual([3]);
    expect(citedDurationDays("1 week")).toEqual([7]);
    expect(citedDurationDays("250 per day")).toEqual([]);
  });
});

describe("checkOutboundNumbers - fabricated rival stays blocked, backed-flaw closed (BUG 2)", () => {
  const bounds = { ceiling: 250, floor: 150, checkAskBounds: true, excludeExact: [5] };

  it("BLOCKS the exact production lie (rival 220 invented, no real rival)", () => {
    const r = checkOutboundNumbers({
      text: "another shop quoted 220, i'd book with you if you can do 200",
      rivalPrice: undefined,
      ...bounds,
    });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("fabricated-rival");
  });

  it("does NOT let our own ask (near a real rival) launder a DIFFERENT fabricated rival", () => {
    // Real rival is 205; our ask 200 is within 5% of it. A fabricated claim of a
    // 260 rival must NOT be backed just because 200 sits near 205 elsewhere.
    const r = checkOutboundNumbers({
      text: "another shop gave me 260. can you do 200 a day?",
      rivalPrice: 205,
      ...bounds,
    });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("fabricated-rival");
  });

  it("ALLOWS a truthful rival claim that matches the real rival", () => {
    const r = checkOutboundNumbers({
      text: "another shop gave me 205, can you match for the 5 days?",
      rivalPrice: 205,
      ...bounds,
    });
    expect(r.ok).toBe(true);
  });
});

describe("stripRivalClaims - repair a non-bargain fabrication", () => {
  it("removes the invented-rival sentence, keeps the rest", () => {
    const out = stripRivalClaims("Thanks for the info. Another shop quoted 220. What is the deposit?");
    expect(out).not.toMatch(/another shop/i);
    expect(out).toMatch(/deposit/i);
  });

  it("returns null when nothing meaningful survives", () => {
    expect(stripRivalClaims("another shop quoted 220")).toBeNull();
  });
});
