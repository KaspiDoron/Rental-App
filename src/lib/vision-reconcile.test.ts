import { describe, it, expect } from "vitest";
import { reconcileVisionPrice, trustedPrice, visionAccuracy } from "./vision-reconcile";

// The live thread: four photo boards, then the shop typed
// "If you rent a Click 125 for 5 days, it costs 1,250฿". The board said 250/day
// for that model - so the text CONFIRMS the read, and nothing checked.
describe("reconcileVisionPrice - the Krabi price-board thread", () => {
  it("a typed trip total confirms a per-day board reading", () => {
    const r = reconcileVisionPrice({ sheetPricePerDay: 250, textTotal: 1250, durationDays: 5 });
    expect(r.agreement).toBe("confirmed");
    expect(r.textPerDay).toBe(250);
  });

  it("a typed daily rate confirms it too", () => {
    expect(reconcileVisionPrice({ sheetPricePerDay: 250, textPricePerDay: 250 }).agreement).toBe(
      "confirmed"
    );
  });

  it("a rounded restatement still agrees (5% band)", () => {
    expect(reconcileVisionPrice({ sheetPricePerDay: 250, textPricePerDay: 260 }).agreement).toBe(
      "confirmed"
    );
  });

  it("a real disagreement is a conflict, with the direction", () => {
    const r = reconcileVisionPrice({ sheetPricePerDay: 250, textPricePerDay: 300 });
    expect(r.agreement).toBe("conflict");
    expect(r.deltaPct).toBeCloseTo(0.2);
    expect(r.detail).toContain("trust the typed price");
  });

  it("never guesses when only one side exists", () => {
    expect(reconcileVisionPrice({ sheetPricePerDay: 250 }).agreement).toBe("unconfirmed");
    expect(reconcileVisionPrice({ textPricePerDay: 250 }).agreement).toBe("unconfirmed");
    expect(reconcileVisionPrice({}).agreement).toBe("unconfirmed");
  });

  it("ignores a total with no duration to divide by", () => {
    expect(reconcileVisionPrice({ sheetPricePerDay: 250, textTotal: 1250 }).agreement).toBe(
      "unconfirmed"
    );
  });
});

describe("trustedPrice - the shop's own words beat our reading of their photo", () => {
  it("prefers the typed price on a conflict", () => {
    expect(trustedPrice({ sheetPricePerDay: 250, textPricePerDay: 300 })).toBe(300);
  });

  it("falls back to the board when nothing was typed", () => {
    expect(trustedPrice({ sheetPricePerDay: 250 })).toBe(250);
  });

  it("is undefined when there is no price at all", () => {
    expect(trustedPrice({})).toBeUndefined();
  });
});

describe("visionAccuracy - the admin KPI", () => {
  const turns = [
    { hadImage: true, agreement: "confirmed" as const },
    { hadImage: true, agreement: "confirmed" as const },
    { hadImage: true, agreement: "conflict" as const },
    { hadImage: true, agreement: "unconfirmed" as const },
    { hadImage: false, agreement: null }, // a text turn never counts
  ];

  it("scores only the turns that were actually judged", () => {
    const k = visionAccuracy(turns);
    expect(k.photoTurns).toBe(4);
    expect(k.accuracyPct).toBe(67); // 2 of 3 judged
    expect(k.verifiedPct).toBe(75); // 3 of 4 photo turns got verified
  });

  it("reports null rather than a flattering zero when nothing is judged", () => {
    const k = visionAccuracy([{ hadImage: true, agreement: "unconfirmed" }]);
    expect(k.accuracyPct).toBeNull();
    expect(k.verifiedPct).toBe(0);
  });

  it("is empty-safe", () => {
    const k = visionAccuracy([]);
    expect(k.photoTurns).toBe(0);
    expect(k.accuracyPct).toBeNull();
  });
});
