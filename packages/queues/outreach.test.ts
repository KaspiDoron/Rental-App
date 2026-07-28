import { describe, it, expect, vi } from "vitest";

// pacing.ts imports "server-only" (a Next server guard) - stub it for Node.
vi.mock("server-only", () => ({}));

import {
  outreachBatchJobId,
  outreachVendorJobId,
  outreachSyncJobId,
} from "./outreach";
import { batchStagger } from "../../src/lib/wa/pacing";
import { planCapacity, batchWindowMs } from "../../src/lib/wa/capacity";

describe("outreach jobId builders - dedup contract (no ':' - BullMQ key separator)", () => {
  it("prefixes each kind and strips unsafe chars", () => {
    expect(outreachBatchJobId("B:1/x")).toBe("ob-B1x");
    expect(outreachVendorJobId("B1", "v:9")).toBe("ov-B1-v9");
    expect(outreachSyncJobId("B1", "completed")).toBe("os-B1-completed");
  });
  it("a retried batch re-adding the same vendor yields the SAME id (BullMQ rejects the dup)", () => {
    expect(outreachVendorJobId("B1", "vX")).toBe(outreachVendorJobId("B1", "vX"));
    // different vendors never collide
    expect(outreachVendorJobId("B1", "vX")).not.toBe(outreachVendorJobId("B1", "vY"));
  });
  it("returns undefined when an id is empty after sanitizing", () => {
    expect(outreachVendorJobId("B1", ":::")).toBeUndefined();
    expect(outreachBatchJobId("")).toBeUndefined();
  });
});

describe("the worker holds the SAME batch promise as the mass route", () => {
  // Both dispatch paths used to build their own schedule - the route from the
  // policy min-gap, this one from a hardcoded 45s - so the same click took a
  // different amount of time depending on which ran it, and neither was
  // accountable for the total. One scheduler, one deadline.
  const stagger = (count: number, plan: string) =>
    batchStagger({
      count,
      hourCap: planCapacity(plan).hourCap,
      gapSec: 45,
      windowMs: batchWindowMs(),
      rand: () => 0.5,
    });

  it("item 0 is immediate and the whole fan-out lands inside the window", () => {
    const { offsets } = stagger(20, "ultra"); // hourCap 40
    expect(offsets[0]).toBe(0);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    }
    expect(offsets[offsets.length - 1]).toBeLessThanOrEqual(batchWindowMs());
  });

  it("the 45s structural gap is honoured when it fits, compressed when it would not", () => {
    // 20 shops x 45s = 15 min exactly at the edge, so it compresses slightly;
    // a small batch keeps the full gap.
    expect(stagger(5, "ultra").gapSecUsed).toBe(45);
    expect(stagger(20, "ultra").compressed).toBe(true);
  });

  it("past the hour cap it still jumps to the next window (a real ceiling)", () => {
    // free hourCap 10: the 11th item lands past the 1-hour boundary
    const { offsets, overflow } = stagger(12, "free");
    expect(offsets[10]).toBeGreaterThanOrEqual(3600_000);
    expect(overflow).toBe(2);
  });
});

describe("concurrent-campaign caps by plan (business => ultra)", () => {
  it("free 1 / pro 2 / ultra 3", () => {
    expect(planCapacity("free").concurrentCampaigns).toBe(1);
    expect(planCapacity("pro").concurrentCampaigns).toBe(2);
    expect(planCapacity("ultra").concurrentCampaigns).toBe(3);
    expect(planCapacity("business").concurrentCampaigns).toBe(3);
    expect(planCapacity(undefined).concurrentCampaigns).toBe(1); // unknown => free
  });
});
