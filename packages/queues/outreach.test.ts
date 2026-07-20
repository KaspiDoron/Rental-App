import { describe, it, expect, vi } from "vitest";

// pacing.ts imports "server-only" (a Next server guard) - stub it for Node.
vi.mock("server-only", () => ({}));

import {
  outreachBatchJobId,
  outreachVendorJobId,
  outreachSyncJobId,
} from "./outreach";
import { cappedStaggerOffsets } from "../../src/lib/wa/pacing";
import { planCapacity } from "../../src/lib/wa/capacity";

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

describe("vendor stagger = cappedStaggerOffsets(n, hourCap, 45) - the 45-75s structural gap", () => {
  it("item 0 is immediate; each in-window gap is 45-75s and strictly increasing", () => {
    const cap = planCapacity("ultra"); // hourCap 40
    const offsets = cappedStaggerOffsets(20, cap.hourCap, 45);
    expect(offsets[0]).toBe(0);
    for (let i = 1; i < offsets.length; i++) {
      const gap = (offsets[i] - offsets[i - 1]) / 1000;
      expect(gap).toBeGreaterThanOrEqual(45);
      expect(gap).toBeLessThanOrEqual(75);
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    }
  });
  it("past the hour cap it jumps to the next window (never over the send budget)", () => {
    // free hourCap 10: the 11th item lands past the 1-hour boundary
    const offsets = cappedStaggerOffsets(12, planCapacity("free").hourCap, 45);
    expect(offsets[10]).toBeGreaterThanOrEqual(3600_000);
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
