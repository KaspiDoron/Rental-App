import { describe, it, expect } from "vitest";
import {
  offersKey,
  listPriceKey,
  aggKey,
  liveFlagKey,
  eventsChannel,
  cheapestCachedRival,
  recordSessionOffer,
  sessionAggregates,
} from "./rival-cache";
import { credibleFloor } from "./graph/math";

describe("rival-cache key schema (shared by both runtimes + the SSE stream)", () => {
  it("scopes the offers ZSET by session + vehicle + currency", () => {
    expect(offersKey(42, "scooter-125", "PHP")).toBe("session:42:scooter-125:PHP:offers");
    expect(listPriceKey(42, "scooter-125", "PHP")).toBe("session:42:scooter-125:PHP:list");
  });
  it("a different vehicle or currency can never share a key (no cross-leverage)", () => {
    expect(offersKey(42, "scooter-125", "PHP")).not.toBe(offersKey(42, "car-economy", "PHP"));
    expect(offersKey(42, "scooter-125", "PHP")).not.toBe(offersKey(42, "scooter-125", "THB"));
  });
  it("agg / live / events keys are per-session", () => {
    expect(aggKey(7)).toBe("session:7:agg");
    expect(liveFlagKey(7)).toBe("session:7:live");
    expect(eventsChannel(7)).toBe("session:7:events");
  });
});

describe("REDIS_URL gating - a strict no-op when unset", () => {
  // In this test env REDIS_URL is unset.
  it("cheapestCachedRival returns null (callers fall back to Postgres)", async () => {
    expect(
      await cheapestCachedRival({
        searchId: 1,
        vehicleKey: "scooter-125",
        currency: "PHP",
        excludeVendorId: "v1",
        belowPrice: 300,
      })
    ).toBeNull();
  });
  it("recordSessionOffer / sessionAggregates never throw and degrade to empty", async () => {
    await recordSessionOffer({
      searchId: 1,
      vendorId: "v1",
      vehicleKey: "scooter-125",
      currency: "PHP",
      pricePerDay: 300,
      listPricePerDay: 300,
      durationDays: 5,
    });
    expect(await sessionAggregates(1)).toEqual({});
  });
});

describe("credibleFloor - the Bargained-0 kill", () => {
  it("clamps a floor STRICTLY ABOVE the live quote to 90% of the quote", () => {
    expect(credibleFloor(350, 300)).toEqual({ floor: 270, clamped: true });
    expect(credibleFloor(310, 300)).toEqual({ floor: 270, clamped: true });
  });
  it("keeps an honest floor at/below the quote untouched", () => {
    expect(credibleFloor(150, 300)).toEqual({ floor: 150, clamped: false });
    expect(credibleFloor(299, 300)).toEqual({ floor: 299, clamped: false });
  });
  it("quote AT the floor is SETTLED, never reopened (the anti-lowball rule)", () => {
    // A shop bargained down to the floor must not be pushed forever.
    expect(credibleFloor(150, 150)).toEqual({ floor: 150, clamped: false });
    expect(credibleFloor(153, 150)).toEqual({ floor: 153, clamped: false }); // within 2%
  });
  it("passes through when either side is unknown", () => {
    expect(credibleFloor(undefined, 300)).toEqual({ floor: undefined, clamped: false });
    expect(credibleFloor(150, undefined)).toEqual({ floor: 150, clamped: false });
    expect(credibleFloor(0, 300)).toEqual({ floor: undefined, clamped: false });
  });
});
