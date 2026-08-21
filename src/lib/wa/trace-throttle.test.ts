import { describe, it, expect } from "vitest";
import { makeTraceThrottle } from "./trace-throttle";
import { readFileSync } from "fs";
import { join } from "path";

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

// OWNER REPORT 7, P1 (I2): THE THROTTLE WAS EATING THE MAGNITUDE.
//
// The rate limit is right - an unthrottled insert on the drop path is a
// self-inflicted DB DoS. But a burst of twenty identical drops wrote ONE row
// and the panel then reported "1 drop" for an incident that lost twenty
// messages. The row now says what it stands for.

describe("a throttled trace still reports how many it swallowed", () => {
  it("THE REGRESSION: the suppressed count survives the throttle", () => {
    const th = makeTraceThrottle(60_000);
    expect(th.allow("k", 0)).toBe(true);
    for (let i = 1; i <= 19; i++) expect(th.allow("k", i)).toBe(false);
    // The next allowed write speaks for all nineteen it silenced.
    expect(th.takeSuppressed("k")).toBe(19);
  });

  it("...and RESETS, so the next window counts only its own", () => {
    const th = makeTraceThrottle(60_000);
    th.allow("k", 0);
    th.allow("k", 1);
    expect(th.takeSuppressed("k")).toBe(1);
    expect(th.takeSuppressed("k"), "drained, not double-counted").toBe(0);
  });

  it("a key that never lost anything reports zero, not a stray count", () => {
    const th = makeTraceThrottle(60_000);
    expect(th.allow("quiet", 0)).toBe(true);
    expect(th.takeSuppressed("quiet")).toBe(0);
    expect(th.takeSuppressed("never-seen")).toBe(0);
  });

  it("counts are per key - one chatty thread cannot inflate another", () => {
    const th = makeTraceThrottle(60_000);
    th.allow("a", 0);
    th.allow("b", 0);
    th.allow("a", 1);
    th.allow("a", 2);
    th.allow("b", 1);
    expect(th.takeSuppressed("a")).toBe(2);
    expect(th.takeSuppressed("b")).toBe(1);
  });

  it("the drop trace actually stamps it, and omits it when it is zero", () => {
    const code = readFileSync(join(process.cwd(), "src/lib/wa/webhook-trace.ts"), "utf8");
    expect(code).toMatch(/dropThrottle\.takeSuppressed\(throttleKey\)/);
    expect(code).toMatch(/alsoSuppressed > 0 \? \{ alsoSuppressed \} : \{\}/);
  });
});
