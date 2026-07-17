import { describe, it, expect } from "vitest";
import { sendProgress } from "./batch-progress";

// Pins the truthfulness rules of the pacing progress line (B-6 edge cases).

const NOW = Date.parse("2026-07-17T12:00:00Z");
const iso = (min: number) => new Date(NOW + min * 60_000).toISOString();

describe("sendProgress", () => {
  it("nothing waiting -> null (line disappears, no zombie '0 left')", () => {
    expect(sendProgress([], 5, NOW)).toBe(null);
  });

  it("derives sent/waiting/total from LIVE rows (mid-batch removals shrink honestly)", () => {
    const p = sendProgress([{ notBefore: iso(1) }, { notBefore: iso(2) }], 3, NOW);
    expect(p).toMatchObject({ sent: 3, waiting: 2, total: 5 });
    // Remove one row -> the plan shrinks, never lies about the old size.
    const p2 = sendProgress([{ notBefore: iso(2) }], 3, NOW);
    expect(p2).toMatchObject({ sent: 3, waiting: 1, total: 4 });
  });

  it("ETA is max(notBefore) - cap holds push it out honestly, never index math", () => {
    const p = sendProgress(
      [{ notBefore: iso(1) }, { notBefore: iso(90) }], // second row held by a cap
      0,
      NOW
    )!;
    expect(p.doneBy).toBe(iso(90));
    expect(p.nextAt).toBe(iso(1));
  });

  it("a due-now row reports dueNow instead of a stale future ETA", () => {
    const p = sendProgress([{ notBefore: iso(-1) }, { notBefore: iso(5) }], 0, NOW)!;
    expect(p.dueNow).toBe(true);
    expect(p.nextAt).toBeUndefined();
  });

  it("overlapping batches simply merge (the user cares about what's left)", () => {
    const p = sendProgress(
      [{ notBefore: iso(1) }, { notBefore: iso(2) }, { notBefore: iso(3) }],
      4,
      NOW
    )!;
    expect(p.total).toBe(7);
    expect(p.waiting).toBe(3);
  });

  it("ignores unparseable timestamps rather than producing NaN math", () => {
    const p = sendProgress([{ notBefore: "garbage" }, { notBefore: iso(2) }], 1, NOW)!;
    expect(p.waiting).toBe(1);
    expect(p.doneBy).toBe(iso(2));
  });
});
