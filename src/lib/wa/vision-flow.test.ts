import { describe, it, expect, vi } from "vitest";

// Module-3 pins: the never-silent photo fallback shape + the vision Flow's
// dedup jobIds. Pure logic only - the live Flow mechanics are covered by the
// redis smoke harness.

vi.mock("server-only", () => ({}));
vi.mock("../runtime-config", () => ({
  getConfig: async () => undefined,
  setConfig: async () => {},
  sbInsert: async () => true,
  sbSelect: async () => [],
  sbUpdate: async () => {},
}));

import { photoClarifyExtraction } from "../agent-loop";
import {
  visionChildJobId,
  visionParentJobId,
} from "../../../packages/queues/vision";

describe("photoClarifyExtraction - the never-silent fallback (Module 3)", () => {
  it("asks warmly for the price in text", () => {
    const e = photoClarifyExtraction();
    expect(e.found).toBe(false);
    expect(e.clarifyMessage).toMatch(/couldn't read that photo/i);
    expect(e.clarifyMessage).toMatch(/type the daily price/i);
  });
  it("matchesSpec stays TRUE - unreadable must never read as wrong-vehicle", () => {
    // matchesSpec=false freezes bargain/probe/present across the whole engine;
    // a broken photo must degrade to a clarify, not a frozen negotiation.
    expect(photoClarifyExtraction().matchesSpec).toBe(true);
    expect(photoClarifyExtraction().confidence).toBe("low");
  });
});

describe("vision Flow jobIds - one flow per provider message id", () => {
  it("parent/child ids derive from the wa message id (redelivery-proof)", () => {
    expect(visionChildJobId("3EB0ABC123")).toBe("vx-3EB0ABC123");
    expect(visionParentJobId("3EB0ABC123")).toBe("vc-3EB0ABC123");
  });
  it("strips characters BullMQ jobIds forbid (the ':' key separator etc.)", () => {
    expect(visionChildJobId("A:B:C")).toBe("vx-ABC");
  });
  it("no id -> undefined (BullMQ falls back to an auto id, no dedup claimed)", () => {
    expect(visionChildJobId("")).toBeUndefined();
    expect(visionParentJobId(undefined as unknown as string)).toBeUndefined();
  });
});
