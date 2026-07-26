import { describe, it, expect } from "vitest";
import { clampWaitMinutes, WAIT_MAX_MINUTES, WAIT_MIN_MINUTES } from "./wait";

// The incident this pins: the model asked for a wait that landed at 08:28 the
// NEXT morning on a thread the shop was actively typing in, and nothing in the
// SPTE path bounded it. A pause is a tactic measured in minutes or it is a bug.
describe("clampWaitMinutes", () => {
  it("never lets a wait run into hours", () => {
    expect(clampWaitMinutes(1085)).toBe(WAIT_MAX_MINUTES); // the live 18h ask
    expect(clampWaitMinutes(60)).toBe(WAIT_MAX_MINUTES);
    expect(clampWaitMinutes(4)).toBe(WAIT_MAX_MINUTES);
  });

  it("keeps a sane ask exactly as asked", () => {
    expect(clampWaitMinutes(1)).toBe(1);
    expect(clampWaitMinutes(2)).toBe(2);
    expect(clampWaitMinutes(3)).toBe(3);
  });

  it("raises a sub-minute ask to the floor", () => {
    expect(clampWaitMinutes(0.2)).toBe(WAIT_MIN_MINUTES);
  });

  it("returns undefined - not 0 - when there is no usable number", () => {
    expect(clampWaitMinutes(undefined)).toBeUndefined();
    expect(clampWaitMinutes(0)).toBeUndefined();
    expect(clampWaitMinutes(-5)).toBeUndefined();
    expect(clampWaitMinutes(NaN)).toBeUndefined();
    expect(clampWaitMinutes(Infinity)).toBeUndefined();
    expect(clampWaitMinutes("5")).toBeUndefined();
    expect(clampWaitMinutes(null)).toBeUndefined();
  });

  it("the band itself stays in minutes - a guard on the guard", () => {
    expect(WAIT_MIN_MINUTES).toBeGreaterThanOrEqual(1);
    expect(WAIT_MAX_MINUTES).toBeLessThanOrEqual(5);
  });
});
