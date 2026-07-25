import { describe, it, expect } from "vitest";
import {
  percentile,
  bucketTurnsPerHour,
  moveMix,
  providerMix,
  latencyStats,
  type StatTurn,
} from "./engine-stats";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

describe("percentile", () => {
  it("returns null for an empty set", () => {
    expect(percentile([], 50)).toBeNull();
  });
  it("nearest-rank p50/p95", () => {
    const xs = [10, 20, 30, 40, 50];
    expect(percentile(xs, 50)).toBe(30);
    expect(percentile(xs, 95)).toBe(50);
  });
  it("ignores non-finite values", () => {
    expect(percentile([NaN, 5, Infinity, 15], 50)).toBe(5);
  });
});

describe("bucketTurnsPerHour", () => {
  it("buckets oldest-first with the current hour last", () => {
    const turns: StatTurn[] = [
      { at: at(5) }, // current hour
      { at: at(50) }, // current hour
      { at: at(70) }, // 1h ago
      { at: at(310) }, // 5h ago (oldest bucket)
    ];
    const b = bucketTurnsPerHour(turns, NOW, 6);
    expect(b).toHaveLength(6);
    expect(b[5]).toBe(2); // current hour
    expect(b[4]).toBe(1); // 1h ago
    expect(b[0]).toBe(1); // 5h ago
    expect(b[1]).toBe(0);
  });
  it("drops rows outside the window and unparseable timestamps", () => {
    const turns: StatTurn[] = [
      { at: at(600) }, // 10h ago - out
      { at: "not-a-date" },
      { at: undefined },
      { at: at(10) }, // in
    ];
    const b = bucketTurnsPerHour(turns, NOW, 6);
    expect(b.reduce((a, c) => a + c, 0)).toBe(1);
  });
});

describe("moveMix / providerMix", () => {
  it("counts descending with sensible fallbacks", () => {
    const turns: StatTurn[] = [
      { move: "bargain", provider: "groq" },
      { move: "bargain", provider: "groq" },
      { move: "present", provider: null },
      { move: undefined, provider: undefined },
    ];
    expect(moveMix(turns)).toEqual([
      { key: "bargain", count: 2 },
      { key: "present", count: 1 },
      { key: "unknown", count: 1 },
    ]);
    const pm = providerMix(turns);
    expect(pm[0]).toEqual({ key: "groq", count: 2 });
    expect(pm.find((p) => p.key === "mock/local")?.count).toBe(2);
  });
});

describe("latencyStats", () => {
  it("summarizes only real samples", () => {
    const turns: StatTurn[] = [
      { latencyMs: 100 },
      { latencyMs: 200 },
      { latencyMs: null },
      { latencyMs: 300 },
      {},
    ];
    const s = latencyStats(turns);
    expect(s.samples).toBe(3);
    expect(s.p50).toBe(200);
    expect(s.p95).toBe(300);
  });
  it("is empty-safe", () => {
    expect(latencyStats([])).toEqual({ p50: null, p95: null, samples: 0 });
  });
});
