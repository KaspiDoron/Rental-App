import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
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

  // DELIBERATELY REWRITTEN, not quietly deleted.
  //
  // This test used to pin pro 30 / ultra 40. Those numbers were never
  // deliverable: usage.ts enforced 15 an hour across BOTH lanes on the one send
  // path, so the app advertised a budget the wire refused and a batch stalled
  // at shop 15 with no surface able to explain why.
  //
  // The tiers now sit at or below the intro lane's real ceiling
  // (LIMIT_WA_INTRO_PER_HOUR = 24), so a plan cannot promise more than the
  // transport will carry. Free stays at 10 - already the safe day-one number.
  it("no tier promises more than the intro lane can actually carry", () => {
    expect(PLAN_CAPACITY.free).toMatchObject({ newContacts: 10, windowHours: 6 });
    expect(PLAN_CAPACITY.pro).toMatchObject({ newContacts: 20, windowHours: 4 });
    expect(PLAN_CAPACITY.ultra).toMatchObject({ newContacts: 24, windowHours: 3 });
  });

  it("REGRESSION: every tier is <= the hourly intro cap, so the wire never refuses a promised send", () => {
    const INTRO_HOUR_CAP = 24; // usage.ts LIMIT_WA_INTRO_PER_HOUR
    for (const tier of ["free", "pro", "ultra"] as const) {
      expect(PLAN_CAPACITY[tier].newContacts).toBeLessThanOrEqual(INTRO_HOUR_CAP);
      // hourCap === newContacts is load-bearing elsewhere (effectiveHourCap
      // floors on it), so keep them in step.
      expect(PLAN_CAPACITY[tier].hourCap).toBe(PLAN_CAPACITY[tier].newContacts);
    }
  });

  it("planCapacity is total (never throws, always a tier)", () => {
    expect(planCapacity("ULTRA").newContacts).toBe(24);
    expect(planCapacity(null).newContacts).toBe(10);
  });
});

describe("the warm-up ramp on NEW CONTACTS (owner report 3, decision 3)", () => {
  // DELIBERATELY REVERSED from the old "full budget day 0" pin. That
  // requirement dated from an earlier round; the owner's third report chose
  // the ramp as the one real product-behavior change: a brand-new number
  // blasting its whole allowance at strangers on day one is the single most
  // bannable pattern WhatsApp meters. Day 0 = ~50%, earning to 100% over
  // warmup_days, accelerated by an OBSERVED reply rate.
  it("day 0 is half the plan budget; maturity is the full budget", () => {
    expect(effectiveNewContactCap("ultra", 0, 7)).toBe(12);
    expect(effectiveNewContactCap("pro", 0, 7)).toBe(10);
    expect(effectiveNewContactCap("free", 0, 7)).toBe(5);
    expect(effectiveNewContactCap("ultra", 7, 7)).toBe(24);
    expect(effectiveNewContactCap("free", 30, 7)).toBe(10);
  });

  it("the INVARIANT: day 0 is strictly below maturity, for every plan", () => {
    for (const plan of ["free", "pro", "ultra"]) {
      expect(effectiveNewContactCap(plan, 0, 7)).toBeLessThan(effectiveNewContactCap(plan, 7, 7));
    }
  });

  it("a measured reply rate earns the budget FASTER - answered messages are the proof", () => {
    const cold = effectiveNewContactCap("ultra", 1, 7, null);
    const answered = effectiveNewContactCap("ultra", 1, 7, 0.4);
    expect(answered).toBeGreaterThan(cold);
    // ...but acceleration is capped: even a perfect rate cannot exceed 100%.
    expect(effectiveNewContactCap("ultra", 1, 7, 1)).toBeLessThanOrEqual(24);
  });

  it("never below one conversation - a ramp is not a mute button", () => {
    expect(effectiveNewContactCap("free", 0, 30)).toBeGreaterThanOrEqual(1);
  });

  it("the zero-send benefit-of-the-doubt cannot unlock day 0 (guard passes null below samples)", () => {
    const guard = readFileSync(join(process.cwd(), "src/lib/wa-guard.ts"), "utf8");
    expect(guard).toMatch(/\(rep\.sent_total \|\| 0\) >= p\.min_reply_samples \? replyRate\(rep\) : null/);
    expect(guard).toMatch(/effectiveNewContactCap\(plan \?\? "free", ageDaysOf\(rep\), p\.warmup_days, measuredReplyRate\)/);
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
  it("floors at the RAMPED budget, so a warm number's batch never splits hours", () => {
    // The floor keeps the original intent - a within-budget batch is stamped
    // inside one hour - but it is now the warm-up-scaled budget rather than the
    // raw one. Before this, `Math.max(cap.newContacts, ...)` swallowed the ramp
    // whole and effectiveHourCap returned the SAME number at every age and
    // trust level for pro and ultra: arithmetic that could not possibly bite,
    // while two docs called it the protection for a new number.
    const warmed = effectiveHourCap("ultra", 6, 7, 7); // fully warmed
    expect(warmed).toBe(24);
    expect(effectiveHourCap("pro", 6, 7, 7)).toBe(20);
    expect(effectiveHourCap("free", 6, 7, 7)).toBe(10);
  });

  it("THE REGRESSION: a day-0 number now gets LESS than a warmed one", () => {
    // warmupFactor floors at 0.85, so the ramp is gentle by design - but it
    // must be visible, not zero.
    for (const plan of ["ultra", "pro", "free"] as const) {
      const day0 = effectiveHourCap(plan, 6, 0, 7);
      const day7 = effectiveHourCap(plan, 6, 7, 7);
      expect(day0, `${plan} day-0 must be below its warmed ceiling`).toBeLessThan(day7);
      expect(day0, `${plan} day-0 must still be usable`).toBeGreaterThan(0);
    }
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
