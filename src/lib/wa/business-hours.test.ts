import { describe, it, expect } from "vitest";
import {
  resolveOffset,
  recipientLocalHour,
  nextBusinessOpen,
  clampToBusinessHours,
  boundHold,
  type HoursPolicy,
} from "./business-hours";

// These helpers were module-private in wa-guard with ZERO coverage - and they
// are exactly where the incident lived: a 19:16 batch on Siquijor (UTC+8) had
// its holds rolled to ~05:38-05:51 the NEXT MORNING because the clamp ignored
// the fast-dispatch dial. The times below are the incident's own.

const P = (over: Partial<HoursPolicy> = {}): HoursPolicy => ({
  business_hour_start: 8,
  business_hour_end: 21,
  ignore_business_hours: false,
  fast_dispatch: false,
  ...over,
});

const INCIDENT_NOW = Date.parse("2026-07-29T11:16:00Z"); // 19:16 on Siquijor
const PH = "639776620146";

describe("resolveOffset", () => {
  it("resolves the Philippines by prefix and by region string", () => {
    expect(resolveOffset(PH)).toEqual({ off: 8, known: true });
    expect(resolveOffset("", "Siquijor, Philippines")).toEqual({ off: 8, known: true });
  });

  it("a NATIONAL spelling (09...) is honestly unknown - the hours gate stands down", () => {
    expect(resolveOffset("09776620146").known).toBe(false);
  });
});

describe("clampToBusinessHours - the incident invariant", () => {
  it("NEVER moves a hold while fast dispatch is on (the 05:38 fix)", () => {
    // A 2-4h breaker hold from 19:16 local lands 21:16-23:16 local - outside
    // the clock window. The old clamp rolled it unconditionally to the next
    // morning's opening; under either 24/7 dial it must stay exactly put.
    const hold = new Date(INCIDENT_NOW + 2 * 3600_000).toISOString();
    expect(clampToBusinessHours(hold, PH, P({ fast_dispatch: true }))).toBe(hold);
    expect(clampToBusinessHours(hold, PH, P({ ignore_business_hours: true }))).toBe(hold);
  });

  it("with both dials OFF an after-hours hold rolls to the next open (the owner's explicit choice)", () => {
    const hold = new Date(INCIDENT_NOW + 2 * 3600_000).toISOString(); // 21:16 local
    const out = clampToBusinessHours(hold, PH, P(), undefined, () => 0);
    expect(out).toBe(new Date(Date.parse("2026-07-30T00:00:00.000Z")).toISOString()); // 08:00 PH
  });

  it("stands down entirely on an unknown timezone - never false-delay an open shop", () => {
    const hold = new Date(INCIDENT_NOW + 2 * 3600_000).toISOString();
    expect(clampToBusinessHours(hold, "09776620146", P())).toBe(hold);
  });

  it("an in-window instant is untouched", () => {
    const hold = new Date(Date.parse("2026-07-29T04:00:00Z")).toISOString(); // 12:00 local
    expect(clampToBusinessHours(hold, PH, P(), undefined, () => 0.9)).toBe(hold);
  });
});

describe("nextBusinessOpen", () => {
  it("lands at opening + bounded jitter in the shop's local frame", () => {
    const base = Date.parse(nextBusinessOpen(PH, P(), undefined, INCIDENT_NOW, () => 0));
    expect(base).toBe(Date.parse("2026-07-30T00:00:00Z")); // 08:00 PH next day
    const jittered = Date.parse(nextBusinessOpen(PH, P(), undefined, INCIDENT_NOW, () => 0.999));
    expect(jittered - base).toBeGreaterThan(0);
    expect(jittered - base).toBeLessThanOrEqual(40 * 60_000);
  });
});

describe("boundHold - an anti-ban hold self-expires inside the plan window", () => {
  it("caps a runaway hold at the window", () => {
    const tenHours = new Date(INCIDENT_NOW + 10 * 3600_000).toISOString();
    expect(boundHold(tenHours, INCIDENT_NOW, 3)).toBe(
      new Date(INCIDENT_NOW + 3 * 3600_000).toISOString()
    );
  });

  it("leaves an in-bound hold alone", () => {
    const two = new Date(INCIDENT_NOW + 2 * 3600_000).toISOString();
    expect(boundHold(two, INCIDENT_NOW, 3)).toBe(two);
  });
});

describe("recipientLocalHour", () => {
  it("11:16Z is hour 19 on Siquijor", () => {
    expect(recipientLocalHour(PH, undefined, INCIDENT_NOW)).toBe(19);
  });
});
