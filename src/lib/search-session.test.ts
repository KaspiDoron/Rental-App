import { describe, it, expect, vi } from "vitest";

// The rival predicate is THE leverage source - these tests pin its rules,
// including the exact reported bug: shop A offered 220, shop B quotes 250,
// the 220 MUST surface as leverage (and everything that should not, must not).

vi.mock("server-only", () => ({}));
vi.mock("./runtime-config", () => ({
  sbSelect: async () => [],
}));

import { pickCheapestRival, type RivalOffer } from "./search-session";

const SINCE = "2026-07-17T08:00:00.000Z";
const IN_SESSION = "2026-07-17T09:00:00.000Z";
const BEFORE_SESSION = "2026-07-17T07:00:00.000Z";

const offer = (over: Partial<RivalOffer>): RivalOffer => ({
  vendorId: "shop-a",
  pricePerDay: 220,
  currency: "THB",
  vehicleKey: "motorbike-125",
  createdAt: IN_SESSION,
  ...over,
});

const args = {
  vendorId: "shop-b",
  currency: "THB",
  vehicleKey: "motorbike-125",
  belowPrice: 250,
  sinceIso: SINCE,
};

describe("pickCheapestRival", () => {
  it("THE 220/250 case: a cheaper same-session rival surfaces", () => {
    expect(pickCheapestRival([offer({})], args)).toBe(220);
  });

  it("ignores the shop being negotiated (no self-leverage)", () => {
    expect(pickCheapestRival([offer({ vendorId: "shop-b" })], args)).toBeUndefined();
  });

  it("ignores offers from BEFORE this search session (stale leverage)", () => {
    expect(pickCheapestRival([offer({ createdAt: BEFORE_SESSION })], args)).toBeUndefined();
  });

  it("never compares across currencies (no invented leverage)", () => {
    expect(pickCheapestRival([offer({ currency: "USD", pricePerDay: 6 })], args)).toBeUndefined();
  });

  it("never compares across vehicle classes", () => {
    expect(pickCheapestRival([offer({ vehicleKey: "car-economy" })], args)).toBeUndefined();
  });

  it("a rival at or above the quote is not leverage", () => {
    expect(pickCheapestRival([offer({ pricePerDay: 250 })], args)).toBeUndefined();
    expect(pickCheapestRival([offer({ pricePerDay: 260 })], args)).toBeUndefined();
  });

  it("duration-aware: the effective daily rate beats the sticker price", () => {
    // Sticker 240/day but a weekly deal makes it effectively 200/day.
    expect(
      pickCheapestRival([offer({ pricePerDay: 240, effectiveDailyRate: 200 })], args)
    ).toBe(200);
  });

  it("picks the CHEAPEST among several eligible rivals", () => {
    expect(
      pickCheapestRival(
        [
          offer({ vendorId: "a", pricePerDay: 230 }),
          offer({ vendorId: "b", pricePerDay: 210 }),
          offer({ vendorId: "c", pricePerDay: 245 }),
        ],
        args
      )
    ).toBe(210);
  });

  it("empty session -> no rival, never a guess", () => {
    expect(pickCheapestRival([], args)).toBeUndefined();
  });
});
