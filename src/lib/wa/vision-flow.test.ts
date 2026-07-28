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
  // THE CONTRACT, NOT THE WORDING. This used to assert the exact sentence
  // ("couldn't read that photo", "type the daily price"), which pins one
  // string rather than the guarantee - and the guarantee is what matters: when
  // the media pipeline fails, a REPLY still exists, it claims no price, it does
  // not accuse the shop of sending the wrong vehicle, and it asks for the one
  // thing we need in text. Fields may be added to it (the vision pipeline needs
  // to carry what kind of image it was); the guarantee may not be removed.
  it("always produces a reply - the shop is never met with silence", () => {
    const e = photoClarifyExtraction();
    expect(e).toBeTruthy();
    expect(String(e.clarifyMessage ?? "").trim().length).toBeGreaterThan(0);
  });

  it("claims no price of its own and asks for one in text", () => {
    const e = photoClarifyExtraction();
    expect(e.found).toBe(false);
    expect(e.pricePerDay).toBeUndefined();
    expect(e.clarifyMessage).toMatch(/price|rate|cost/i);
  });

  it("matchesSpec stays TRUE - unreadable must never read as wrong-vehicle", () => {
    // matchesSpec=false freezes bargain/probe/present across the whole engine;
    // a broken photo must degrade to a clarify, not a frozen negotiation.
    expect(photoClarifyExtraction().matchesSpec).toBe(true);
    expect(photoClarifyExtraction().confidence).toBe("low");
  });

  it("is pure - the same fallback every time, with no hidden state", () => {
    expect(photoClarifyExtraction()).toEqual(photoClarifyExtraction());
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
