import { describe, it, expect } from "vitest";
import { PACING_PRESETS, normalizePacingMode } from "./pacing-mode";

describe("normalizePacingMode", () => {
  it("maps known aliases", () => {
    expect(normalizePacingMode("fast")).toBe("fast");
    expect(normalizePacingMode("AGGRESSIVE")).toBe("fast");
    expect(normalizePacingMode(" turbo ")).toBe("fast");
    expect(normalizePacingMode("cautious")).toBe("cautious");
    expect(normalizePacingMode("safe")).toBe("cautious");
    expect(normalizePacingMode("stealth")).toBe("cautious");
  });

  it("defaults to balanced for unknown / empty / null", () => {
    expect(normalizePacingMode("balanced")).toBe("balanced");
    expect(normalizePacingMode("nonsense")).toBe("balanced");
    expect(normalizePacingMode("")).toBe("balanced");
    expect(normalizePacingMode(undefined)).toBe("balanced");
    expect(normalizePacingMode(null)).toBe("balanced");
  });
});

describe("PACING_PRESETS trade the speed/safety dial monotonically", () => {
  it("balanced is a no-op layer (uses the tuned DEFAULTS)", () => {
    expect(PACING_PRESETS.balanced).toEqual({});
  });

  it("fast is faster (smaller gap) and cautious is safer (bigger gap) than balanced", () => {
    // balanced = DEFAULTS (min_gap 12). fast < 12 < cautious.
    expect(PACING_PRESETS.fast.min_gap_seconds).toBeLessThan(12);
    expect(PACING_PRESETS.cautious.min_gap_seconds).toBeGreaterThan(12);
  });

  it("cautious pauses earlier and fast later than the default threshold (70)", () => {
    expect(PACING_PRESETS.cautious.risk_pause_threshold).toBeLessThan(70);
    expect(PACING_PRESETS.fast.risk_pause_threshold).toBeGreaterThan(70);
  });

  it("cautious tightens bursts and lowers the daily ceiling", () => {
    expect(PACING_PRESETS.cautious.burst_max_in_window).toBeLessThan(
      PACING_PRESETS.fast.burst_max_in_window as number
    );
    expect(PACING_PRESETS.cautious.day_cap).toBeLessThan(220); // below the default backstop
  });
});
