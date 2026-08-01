import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { poissonDelayMs, JITTER_MIN_MS, JITTER_MAX_MS } from "./jitter";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// A fixed interval is a fingerprint. So is a uniform one, once you have enough
// samples: it forms a flat-topped block with hard edges, which no human
// produces. These tests pin the three properties that make the draw useful -
// bounded, correctly centred, and not repeating.

const draws = (n: number, rand: () => number = Math.random) =>
  Array.from({ length: n }, () => poissonDelayMs(rand));

describe("the jitter stays inside the band the owner specified", () => {
  it("10k draws are all within [800, 2400]", () => {
    const all = draws(10_000);
    expect(Math.min(...all)).toBeGreaterThanOrEqual(JITTER_MIN_MS);
    expect(Math.max(...all)).toBeLessThanOrEqual(JITTER_MAX_MS);
    expect(JITTER_MIN_MS).toBe(800);
    expect(JITTER_MAX_MS).toBe(2400);
  });

  it("extreme rand values cannot escape or produce Infinity", () => {
    expect(poissonDelayMs(() => 0)).toBe(JITTER_MIN_MS);
    expect(poissonDelayMs(() => 1)).toBe(JITTER_MAX_MS);
    expect(Number.isFinite(poissonDelayMs(() => 1))).toBe(true);
  });
});

describe("...and has the SHAPE, not just randomness", () => {
  const all = draws(20_000);
  const mean = all.reduce((a, b) => a + b, 0) / all.length;

  it("the mean sits in the lower half of the band, as an exponential should", () => {
    // Uniform noise over the same band would centre on 1600. An exponential
    // tail centres near 1280 - mostly short gaps, occasionally a long one.
    expect(mean).toBeGreaterThan(1150);
    expect(mean).toBeLessThan(1400);
  });

  it("REGRESSION: the floor is not a pile-up - the shift is what prevents it", () => {
    // A raw exponential clamped at 800 would put ~49% of draws exactly on the
    // floor, re-creating the constant we are trying to avoid.
    const onFloor = all.filter((d) => d === JITTER_MIN_MS).length / all.length;
    expect(onFloor).toBeLessThan(0.02);
    // The ceiling carries the tail and is allowed a little mass, but not much.
    const onCeiling = all.filter((d) => d === JITTER_MAX_MS).length / all.length;
    expect(onCeiling).toBeLessThan(0.1);
    // Short gaps dominate long ones - the defining property of the process.
    const short = all.filter((d) => d < 1200).length;
    const long = all.filter((d) => d >= 1800).length;
    expect(short).toBeGreaterThan(long);
  });

  it("consecutive draws differ - a fixed interval is itself a signature", () => {
    const seq = draws(200);
    const repeats = seq.filter((d, i) => i > 0 && d === seq[i - 1]).length;
    expect(repeats).toBeLessThan(5);
    expect(new Set(seq).size).toBeGreaterThan(150);
  });
});

describe("it is on the send path, and only the background one", () => {
  const evolution = readCode("src/lib/evolution.ts");

  it("the pause runs immediately before the Evolution send call", () => {
    const i = evolution.indexOf("await poissonPause()");
    const j = evolution.indexOf("const trySend = async ()");
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(j);
  });

  it("an interactive send is never delayed by it", () => {
    expect(evolution).toMatch(/if \(!fast\) \{\s*const \{ poissonPause \} = await import\("\.\/wa\/jitter"\);/);
  });
});
