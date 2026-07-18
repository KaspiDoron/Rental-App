import { describe, it, expect } from "vitest";
import { stealthFactor } from "./stealth";

// Pins the danger-zone contract: calm numbers run at full speed, a wobbling
// number paces progressively slower (never a hard freeze), and the ramp is
// monotonic up to the hard pause.

describe("stealthFactor", () => {
  const PAUSE = 70;

  it("is 1x while the number is calm (risk at/under 40% of the pause threshold)", () => {
    expect(stealthFactor(0, PAUSE)).toBe(1);
    expect(stealthFactor(28, PAUSE)).toBe(1); // 0.4 * 70
    expect(stealthFactor(10, PAUSE)).toBe(1);
  });

  it("ramps toward 3x as risk approaches the hard pause, never beyond", () => {
    const mid = stealthFactor(49, PAUSE); // halfway through the band
    expect(mid).toBeGreaterThan(1);
    expect(mid).toBeLessThan(3);
    expect(stealthFactor(70, PAUSE)).toBeCloseTo(3, 5);
    expect(stealthFactor(100, PAUSE)).toBe(3); // clamped, never > 3x
  });

  it("is monotonic non-decreasing in risk", () => {
    let prev = 0;
    for (let r = 0; r <= 100; r += 5) {
      const f = stealthFactor(r, PAUSE);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  it("never freezes - always a finite multiplier >= 1", () => {
    expect(stealthFactor(100, PAUSE)).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(stealthFactor(100, PAUSE))).toBe(true);
    // Degenerate threshold does not divide by zero.
    expect(Number.isFinite(stealthFactor(100, 0))).toBe(true);
  });
});
