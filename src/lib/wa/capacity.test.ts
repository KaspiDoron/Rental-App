import { describe, it, expect } from "vitest";
import {
  planCapacity,
  normalizeCapacityPlan,
  warmupFactor,
  effectiveNewContactCap,
  effectiveHourCap,
  nextIntroSlotIso,
  PLAN_CAPACITY,
} from "./capacity";

describe("plan capacity tiers", () => {
  it("maps plan ids, with ultra/business alias and free fallback", () => {
    expect(normalizeCapacityPlan("free")).toBe("free");
    expect(normalizeCapacityPlan("pro")).toBe("pro");
    expect(normalizeCapacityPlan("ultra")).toBe("ultra");
    expect(normalizeCapacityPlan("business")).toBe("ultra"); // legacy db value
    expect(normalizeCapacityPlan(undefined)).toBe("free");
    expect(normalizeCapacityPlan("nonsense")).toBe("free");
  });

  it("meets the owner's capacity targets", () => {
    expect(PLAN_CAPACITY.free).toMatchObject({ newContacts: 10, windowHours: 6 });
    expect(PLAN_CAPACITY.pro).toMatchObject({ newContacts: 30, windowHours: 4 });
    expect(PLAN_CAPACITY.ultra).toMatchObject({ newContacts: 40, windowHours: 3 });
  });

  it("planCapacity is total (never throws, always a tier)", () => {
    expect(planCapacity("ULTRA").newContacts).toBe(40);
    expect(planCapacity(null).newContacts).toBe(10);
  });
});

describe("full-budget-day-0 conversation cap", () => {
  it("gives a BRAND-NEW number its FULL plan budget of conversations - no warm-up crush", () => {
    // The owner's requirement: a fresh ultra user can start all 40 conversations
    // on day 0, within minutes. Warm-up must never reduce the COUNT.
    expect(effectiveNewContactCap("ultra", 0, 7)).toBe(40);
    expect(effectiveNewContactCap("pro", 0, 7)).toBe(30);
    expect(effectiveNewContactCap("free", 0, 7)).toBe(10);
  });

  it("stays at the full budget as the number ages", () => {
    expect(effectiveNewContactCap("ultra", 7, 7)).toBe(40);
    expect(effectiveNewContactCap("free", 30, 7)).toBe(10);
  });
});

describe("gentle warm-up ramp (rate only, never below budget)", () => {
  it("starts at a high 85% floor - a fresh number is fast, not crippled", () => {
    expect(warmupFactor(0, 7)).toBeCloseTo(0.85, 5);
  });

  it("ramps to full by warmupDays", () => {
    expect(warmupFactor(7, 7)).toBe(1);
    expect(warmupFactor(30, 7)).toBe(1);
  });
});

describe("effectiveHourCap - never below the conversation budget", () => {
  it("floors at the plan's newContacts so a within-budget batch never splits hours", () => {
    // Even a brand-new low-trust ultra number gets an hourly cap >= 40, so the
    // 40-conversation burst is never stamped an hour apart.
    expect(effectiveHourCap("ultra", 6, 0, 7)).toBe(40);
    expect(effectiveHourCap("pro", 6, 0, 7)).toBe(30);
    expect(effectiveHourCap("free", 6, 0, 7)).toBe(10);
  });

  it("a very high trust base can raise the ceiling above the budget", () => {
    // trust base 60 (hypothetical) beats the ultra budget of 40.
    expect(effectiveHourCap("ultra", 60, 7, 7)).toBe(60);
  });
});

describe("nextIntroSlotIso - rolling window refresh", () => {
  const now = Date.parse("2026-07-17T12:00:00.000Z");
  const H = 3600_000;

  it("returns now when under budget (a slot is free)", () => {
    const iso = nextIntroSlotIso([], 3, 10, now);
    expect(Date.parse(iso)).toBe(now);
  });

  it("frees when the oldest introduction ages out of the window", () => {
    // cap 2, two intros used: oldest at now-1h => frees at now-1h + windowHours.
    const oldest = new Date(now - 1 * H).toISOString();
    const newer = new Date(now - 0.2 * H).toISOString();
    const iso = nextIntroSlotIso([oldest, newer], 3, 2, now);
    expect(Date.parse(iso)).toBe(now - 1 * H + 3 * H); // = now + 2h
  });

  it("never surfaces a tomorrow-scale wall (bounded by windowHours)", () => {
    const stamps = Array.from({ length: 40 }, (_, i) =>
      new Date(now - (40 - i) * 60_000).toISOString()
    );
    const iso = nextIntroSlotIso(stamps, 3, 40, now);
    const waitMs = Date.parse(iso) - now;
    expect(waitMs).toBeLessThanOrEqual(3 * H); // at most the window, never ~a day
  });
});
