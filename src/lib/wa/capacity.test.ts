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
    expect(PLAN_CAPACITY.pro).toMatchObject({ newContacts: 15, windowHours: 4 });
    expect(PLAN_CAPACITY.ultra).toMatchObject({ newContacts: 40, windowHours: 3 });
  });

  it("planCapacity is total (never throws, always a tier)", () => {
    expect(planCapacity("ULTRA").newContacts).toBe(40);
    expect(planCapacity(null).newContacts).toBe(10);
  });
});

describe("humane warm-up ramp", () => {
  it("starts at a usable 45% floor, not the old ~14%", () => {
    // The whole point: a fresh number is no longer nearly mute.
    expect(warmupFactor(0, 7)).toBeCloseTo(0.45, 5);
    expect(effectiveNewContactCap("ultra", 0, 7)).toBe(18); // round(40*0.45)
    expect(effectiveNewContactCap("free", 0, 7)).toBe(5); // round(10*0.45)
  });

  it("ramps to full capacity by warmupDays", () => {
    expect(warmupFactor(7, 7)).toBe(1);
    expect(warmupFactor(30, 7)).toBe(1);
    expect(effectiveNewContactCap("ultra", 7, 7)).toBe(40);
    expect(effectiveNewContactCap("free", 7, 7)).toBe(10);
  });

  it("mid-ramp uses the linear value once it clears the floor", () => {
    // day 3: (3+1)/7 = 0.571 > 0.45 floor
    expect(warmupFactor(3, 7)).toBeCloseTo(0.571, 3);
  });
});

describe("effectiveHourCap", () => {
  it("takes the higher of trust-base and plan headroom, warm-up ramped", () => {
    // warmed number, trust base 6: free floor 6, ultra headroom 18.
    expect(effectiveHourCap("free", 6, 7, 7)).toBe(6);
    expect(effectiveHourCap("ultra", 6, 7, 7)).toBe(18);
    // a high-trust base beats a small plan headroom.
    expect(effectiveHourCap("free", 14, 7, 7)).toBe(14);
  });

  it("day-0 ultra is ramped but still well above the old 1/hr", () => {
    expect(effectiveHourCap("ultra", 6, 0, 7)).toBe(8); // round(18*0.45)
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
