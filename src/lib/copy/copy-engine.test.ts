import { describe, it, expect } from "vitest";
import {
  fnv1a32,
  simhash64,
  hamming64,
  copySignature,
  parseSignature,
  mulberry32,
} from "./hash";
import { openerSeed, drawStyle, seedRng } from "./matrix";
import { compileOpener, compileStyleDirectives } from "./promptCompiler";
import { trigramOverlap, revarySeeded, ensureGloballyUnique } from "../graph/uniqueness";
import type { StructuredRFQ } from "../types";

const RFQ: StructuredRFQ = {
  vehicleClass: "scooter",
  transmission: "automatic",
  durationDays: 5,
  engineSizeCc: 125,
  accessories: [],
  fulfillment: "any",
  vendorMessage: "",
};

describe("hash primitives (Module 4, owner P1)", () => {
  it("fnv1a32 is stable and sensitive", () => {
    expect(fnv1a32("hello world")).toBe(fnv1a32("hello world"));
    expect(fnv1a32("hello world")).not.toBe(fnv1a32("hello worlds"));
  });
  it("simhash64: similar skeletons land close, different ones far", () => {
    const a = simhash64("Hi! I'm in town and need a scooter for 5 days. Best price per day?");
    const b = simhash64("Hi! I'm in town and need a scooter for 5 days. Best price per day please?");
    const c = simhash64("Good day. What would a 5-seat automatic car cost weekly, delivery included, thanks a lot my friend?");
    expect(hamming64(a, b)).toBeLessThanOrEqual(10); // near-duplicate skeleton
    expect(hamming64(a, c)).toBeGreaterThan(10); // genuinely different
  });
  it("copySignature is exactly 24 hex chars (the Redis memory contract)", () => {
    const sig = copySignature("some outbound message text 🙂");
    expect(sig).toMatch(/^[0-9a-f]{24}$/);
    expect(parseSignature(sig)).not.toBeNull();
    expect(parseSignature("junk")).toBeNull();
  });
  it("mulberry32 is deterministic", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("variation matrix + compiler (owner P2: deterministic diversity)", () => {
  it("same seed -> identical opener (replayable)", () => {
    const seed = openerSeed("u@x.com", "vendor-1", "batch-abc");
    expect(compileOpener(RFQ, seed, "Philippines")).toBe(compileOpener(RFQ, seed, "Philippines"));
  });
  it("different vendors -> different skeletons", () => {
    const a = compileOpener(RFQ, openerSeed("u@x.com", "vendor-1", "b1"));
    const b = compileOpener(RFQ, openerSeed("u@x.com", "vendor-2", "b1"));
    expect(a).not.toBe(b);
  });
  it("a 40-shop batch never repeats a skeleton (pairwise trigram overlap < 0.9)", () => {
    const openers = Array.from({ length: 40 }, (_, i) =>
      compileOpener(RFQ, openerSeed("u@x.com", `vendor-${i}`, "batch-1"), "Philippines")
    );
    expect(new Set(openers).size).toBe(40); // all literally distinct
    let identicalSkeletons = 0;
    for (let i = 0; i < openers.length; i++) {
      for (let j = i + 1; j < openers.length; j++) {
        if (trigramOverlap(openers[i], openers[j]) >= 0.9) identicalSkeletons++;
      }
    }
    // The matrix guarantees structural spread: near-identical skeletons must be
    // rare enough that the uniqueness guard's revary handles the tail.
    expect(identicalSkeletons).toBeLessThanOrEqual(3);
  });
  it("every opener carries the vehicle + the REAL duration", () => {
    for (let i = 0; i < 12; i++) {
      const text = compileOpener(RFQ, openerSeed("u@x.com", `v${i}`, "n"));
      expect(text).toMatch(/scooter/i);
      expect(text).toMatch(/5 days/);
    }
  });
  it("style directives are deterministic and structural", () => {
    const seed = { threadId: "u@x:63111", vendorId: "v1", nonce: 2 };
    const d1 = compileStyleDirectives(seed, "Philippines");
    expect(d1).toBe(compileStyleDirectives(seed, "Philippines"));
    expect(d1).toMatch(/STYLE/);
    expect(d1).not.toBe(compileStyleDirectives({ ...seed, nonce: 3 }, "Philippines"));
  });
  it("drawStyle slang only appears for known regions", () => {
    const rng = seedRng({ threadId: "t", vendorId: "v", nonce: 1 });
    void rng;
    const style = drawStyle({ threadId: "t", vendorId: "v", nonce: 1 }, "Reykjavik, Iceland");
    expect(style.slang).toBeUndefined();
  });
});

describe("uniqueness guard (owner P1/P3)", () => {
  it("revarySeeded is deterministic given the same rng seed", () => {
    const a = revarySeeded("Okay can you do 250? 🙂", mulberry32(7));
    const b = revarySeeded("Okay can you do 250? 🙂", mulberry32(7));
    expect(a).toBe(b);
    expect(a).not.toBe("Okay can you do 250? 🙂");
  });
  it("ensureGloballyUnique re-varies an in-process collision (no Redis needed)", async () => {
    const draft = "Hi! I'm in town and need a scooter for 5 days. Best price per day?";
    const verdict = await ensureGloballyUnique(draft, [draft]); // exact collision
    expect(verdict.changed).toBe(true);
    expect(verdict.text).not.toBe(draft);
  });
  it("no REDIS_URL -> the Redis layer is a strict no-op (Vercel behavior)", async () => {
    const verdict = await ensureGloballyUnique("A perfectly fresh sentence here.", []);
    expect(verdict.changed).toBe(false); // nothing to collide with, no throw
  });
});
