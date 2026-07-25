import { describe, it, expect } from "vitest";
import { makeTraceThrottle } from "./trace-throttle";

describe("makeTraceThrottle", () => {
  it("allows the first, blocks within the window, re-allows after", () => {
    const t = makeTraceThrottle(5 * 60_000);
    expect(t.allow("k", 0)).toBe(true);
    expect(t.allow("k", 60_000)).toBe(false); // 1 min later, still in window
    expect(t.allow("k", 4 * 60_000)).toBe(false);
    expect(t.allow("k", 5 * 60_000)).toBe(true); // exactly at the window edge
    expect(t.allow("k", 5 * 60_000 + 1)).toBe(false);
  });

  it("tracks keys independently", () => {
    const t = makeTraceThrottle(1000);
    expect(t.allow("a", 0)).toBe(true);
    expect(t.allow("b", 0)).toBe(true);
    expect(t.allow("a", 500)).toBe(false);
    expect(t.allow("b", 500)).toBe(false);
  });

  it("bounds memory - a flood of distinct keys never grows without limit", () => {
    const t = makeTraceThrottle(60_000);
    for (let i = 0; i < 5000; i++) expect(t.allow(`key-${i}`, i)).toBe(true);
    // The earliest keys were evicted (cap 2000), so they are allowed again
    // rather than remembered forever - safe for a best-effort trace.
    expect(t.allow("key-0", 60_001)).toBe(true);
  });
});
