import { describe, it, expect, beforeEach } from "vitest";
import { claimDrainSlot, resetDrainSlots, DRAIN_OWNER_INTERVAL_MS } from "./drain-owner";
import { readFileSync } from "fs";
import { join } from "path";

// E2/L2 (owner report 6): the three sibling polls each drained the same
// user's queue inline, so the 8s replies poll could sit behind 16s of drain
// before answering. One claim per user per interval; the rest answer fast.

beforeEach(() => resetDrainSlots());

describe("one drain owner per user per cycle", () => {
  it("the first poll claims; siblings inside the interval skip", () => {
    expect(claimDrainSlot("a@x.com", DRAIN_OWNER_INTERVAL_MS, 1_000)).toBe(true);
    expect(claimDrainSlot("a@x.com", DRAIN_OWNER_INTERVAL_MS, 5_000)).toBe(false);
    expect(claimDrainSlot("a@x.com", DRAIN_OWNER_INTERVAL_MS, 20_999)).toBe(false);
  });

  it("the claim frees itself after the interval", () => {
    expect(claimDrainSlot("a@x.com", DRAIN_OWNER_INTERVAL_MS, 1_000)).toBe(true);
    expect(claimDrainSlot("a@x.com", DRAIN_OWNER_INTERVAL_MS, 21_001)).toBe(true);
  });

  it("users never block each other", () => {
    expect(claimDrainSlot("a@x.com", DRAIN_OWNER_INTERVAL_MS, 1_000)).toBe(true);
    expect(claimDrainSlot("b@x.com", DRAIN_OWNER_INTERVAL_MS, 1_000)).toBe(true);
  });
});

describe("all three sibling polls go through the claim", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  for (const route of [
    "src/app/api/replies/route.ts",
    "src/app/api/activity/route.ts",
    "src/app/api/wa/status/route.ts",
  ]) {
    it(route, () => {
      const src = read(route);
      expect(src).toMatch(/claimDrainSlot\(session\.email\)/);
      // The drains must sit INSIDE the claim - a claim beside an
      // unconditional drain is decoration.
      const claimAt = src.indexOf("claimDrainSlot(session.email)");
      const drainAt = src.indexOf("drainOutbox(", claimAt);
      expect(drainAt).toBeGreaterThan(claimAt);
    });
  }
});
