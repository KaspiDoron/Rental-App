import { describe, it, expect } from "vitest";
import { effectivePriceFor } from "./effective-price";
import { rankPresentable, cheapestPresentable } from "./offer-presentation";

// OWNER REPORT 6, WAVE D - screen truth's two shared rules, executed.
//
// D2: ONE effective-price resolver (was inline in /api/replies; Trips knew
// nothing). D4: ONE best-price ranking (was five private copies).

describe("D2: the effective price consults every source in trust order", () => {
  it("a confirmed row needs no effective price", () => {
    expect(
      effectivePriceFor({ found: true, rowPrice: 250, threadPrice: 200 })
    ).toBeNull();
  });

  it("1st: the thread's standing price", () => {
    const p = effectivePriceFor({
      found: false,
      rowPrice: null,
      rowCurrency: "THB",
      threadPrice: 270,
      options: [{ pricePerDay: 250, currency: "THB" }],
    });
    expect(p).toEqual({ pricePerDay: 270, currency: "THB", source: "thread", vehicle: null });
  });

  it("2nd: the photographed board - crossed-out rows never become the number", () => {
    const p = effectivePriceFor({
      found: false,
      rowPrice: null,
      boardPrices: [
        { pricePerDay: 200, available: false, vehicle: "Click 125", currency: "THB" },
        { pricePerDay: 300, vehicle: "Fazzio 125", currency: "THB" },
      ],
      engineSizeCc: 125,
    });
    expect(p?.pricePerDay).toBe(300);
    expect(p?.source).toBe("menu-photo");
  });

  it("3rd: a SINGLE-option menu is still a price (the >=2 gate is dead)", () => {
    // A shop that named exactly one model with one price sat on "No price
    // yet" forever - the old gate required a CHOICE before it saw a number.
    const p = effectivePriceFor({
      found: false,
      rowPrice: null,
      options: [{ pricePerDay: 250, currency: "THB", label: "Click 125" }],
    });
    expect(p).toEqual({ pricePerDay: 250, currency: "THB", source: "menu", vehicle: "Click 125" });
  });

  it("nothing anywhere is an honest null", () => {
    expect(effectivePriceFor({ found: false, rowPrice: null })).toBeNull();
  });
});

describe("D4: one ranking rule for every 'best' surface", () => {
  const v = (
    price: number,
    extra: { currency?: string; vehicleStatus?: string; stage?: string } = {}
  ) => ({
    offer: {
      pricePerDay: price,
      currency: extra.currency ?? "THB",
      ...(extra.vehicleStatus ? { vehicleStatus: extra.vehicleStatus } : {}),
    },
    stage: extra.stage,
  });

  it("a wrong-vehicle price never ranks", () => {
    const ranked = rankPresentable(
      [v(150, { vehicleStatus: "wrong-vehicle" }), v(300)] as never[],
      "THB"
    );
    expect(ranked.map((r) => (r as ReturnType<typeof v>).offer.pricePerDay)).toEqual([300]);
  });

  it("out-of-stock and declined shops never rank", () => {
    const ranked = rankPresentable(
      [v(100, { stage: "out-of-stock" }), v(120, { stage: "declined" }), v(300)] as never[],
      "THB"
    );
    expect(ranked.map((r) => (r as ReturnType<typeof v>).offer.pricePerDay)).toEqual([300]);
  });

  it("another currency never 'beats' the dominant one", () => {
    const ranked = rankPresentable([v(5, { currency: "USD" }), v(200)] as never[], "THB");
    expect(ranked.map((r) => (r as ReturnType<typeof v>).offer.pricePerDay)).toEqual([200]);
  });

  it("cheapestPresentable is exactly rank[0]", () => {
    const list = [v(300), v(200), v(250)] as never[];
    expect(cheapestPresentable(list, "THB")).toBe(rankPresentable(list, "THB")[0]);
  });
});
