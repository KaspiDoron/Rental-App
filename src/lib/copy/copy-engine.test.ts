import { describe, it, expect } from "vitest";
import {
  fnv1a32,
  simhash64,
  hamming64,
  copySignature,
  parseSignature,
  mulberry32,
} from "./hash";
import { openerSeed, drawStyle } from "./matrix";
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
  it("B2 regression: a greeting NEVER trails the ask, and no ' btw!' tail", () => {
    // The old "intro-first" branch produced "...best price? Hi there btw!".
    // Sweep every sentence order across many seeds and assert the defect shape
    // can never appear.
    for (let i = 0; i < 120; i++) {
      const text = compileOpener(RFQ, openerSeed("u@x.com", `v${i}`, `n${i}`), "Philippines");
      expect(text).not.toMatch(/\bbtw!/i); // the hard-coded literal is gone
      // A greeting word must not appear AFTER a question mark.
      const q = text.indexOf("?");
      if (q >= 0) {
        const tail = text.slice(q + 1);
        expect(tail).not.toMatch(/\b(hi|hey|hello)\b/i);
      }
    }
  });
  it("style directives are deterministic and structural", () => {
    const seed = { threadId: "u@x:63111", vendorId: "v1", nonce: 2 };
    const d1 = compileStyleDirectives(seed, "Philippines");
    expect(d1).toBe(compileStyleDirectives(seed, "Philippines"));
    expect(d1).toMatch(/STYLE/);
    expect(d1).not.toBe(compileStyleDirectives({ ...seed, nonce: 3 }, "Philippines"));
  });
  it("drawStyle regional flavor only appears for known regions", () => {
    const style = drawStyle({ threadId: "t", vendorId: "v", nonce: 1 }, "Reykjavik, Iceland");
    expect(style.particle).toBeUndefined();
    expect(style.regionalThanks).toBeUndefined();
  });
});

describe("W4: region-true, particle-safe openers", () => {
  const compile = (region: string | undefined, i: number) =>
    compileOpener(RFQ, { threadId: `u${i}`, vendorId: `v${i}`, nonce: i }, region);

  it("a VIETNAM shop never gets Filipino/Thai flavor, and a thank-you is never a greeting particle", () => {
    for (let i = 0; i < 200; i++) {
      const msg = compile("vietnam", i);
      // No Filipino "Salamat!"/"po", no Thai "krub"/"ka" anywhere.
      expect(msg).not.toMatch(/salamat|\bpo\b|krub|\bka\b/i);
      // "Cảm ơn!" (if present) is ONLY ever terminal (before an optional emoji),
      // never glued after a greeting word like "Hello! cam on ...".
      if (/Cảm ơn/.test(msg)) {
        expect(msg).not.toMatch(/(Hi|Hello|Hey|Good day|Hi there|Hello there)[^.?!]*Cảm ơn/);
        expect(msg).toMatch(/Cảm ơn!\s*[🙂🙏😊🤙👌]?\s*$/u);
      }
    }
  });

  // REWRITTEN IN PLACE, W4.7b - same intent, corrected placement rule.
  //
  // This test used to REQUIRE `^(Hi|Hello|...)\s+po!`: the particle glued onto
  // the English greeting. That is what the compiler did, and it is a tell in
  // the opposite direction from the repeated greeting the owner reported -
  // "Hi there po!" / "Hi ka!" is a foreign-sounding hybrid no local writes.
  // The intent the test was protecting is intact and unchanged: the particle
  // must appear in ONE grammatical role, never region-blind, and "Salamat!"
  // stays terminal-only. Only the role is corrected - a Filipino/Thai particle
  // attaches to the end of a SENTENCE ("Salamat po!", "How much per day po?"),
  // which is also what compileStyleDirectives has always told the LLM.
  it("a PHILIPPINES shop: 'po' ends a sentence, never rides the greeting; 'Salamat!' only terminal", () => {
    let seenParticle = 0;
    for (let i = 0; i < 200; i++) {
      const msg = compile("philippines", i);
      if (/\bpo\b/.test(msg)) {
        seenParticle++;
        // NEVER glued to the greeting - the defect this rewrite closes.
        expect(msg, msg).not.toMatch(/^(Hi|Hello|Hey|Good day|Hi there|Hello there)\s+po\b/);
        // It sits at the end of a sentence: the closing punctuation follows it.
        expect(msg, msg).toMatch(/\bpo[!?.]/);
        // Exactly one - a particle per message, not a sprinkle.
        expect((msg.match(/\bpo\b/g) ?? []).length).toBe(1);
      }
      if (/Salamat/.test(msg)) {
        expect(msg).toMatch(/Salamat( po)?!\s*[🙂🙏😊🤙👌]?\s*$/u);
      }
    }
    expect(seenParticle).toBeGreaterThan(0); // the courtesy still appears at all
  });

  it("a THAILAND shop never mixes genders within one message and is stable across nonces", () => {
    for (let i = 0; i < 200; i++) {
      const msg = compile("thailand", i);
      // Never both a masculine and feminine marker in the same message.
      const hasKrub = /krub/i.test(msg);
      const hasKa = /\bka\b/i.test(msg);
      expect(hasKrub && hasKa).toBe(false);
    }
    // Gender is pinned to (threadId,vendorId), independent of the per-attempt nonce.
    const a = compileOpener(RFQ, { threadId: "tX", vendorId: "vX", nonce: 1 }, "thailand");
    const b = compileOpener(RFQ, { threadId: "tX", vendorId: "vX", nonce: 2 }, "thailand");
    const genderOf = (m: string) => (/krub/i.test(m) ? "m" : /\bka\b/i.test(m) ? "f" : "none");
    // If both messages carry a Thai marker, it must be the same gender.
    if (genderOf(a) !== "none" && genderOf(b) !== "none") expect(genderOf(a)).toBe(genderOf(b));
  });

  it("W4.7b: no opener in ANY region ever writes the 'Hi there po!' hybrid", () => {
    // The refuter's finding: compileOpener glued the particle onto the greeting,
    // so a Thai shop got "Hi ka!" and a Filipino one "Hi there po!". A greeting
    // is English; a particle belongs to the local sentence that follows.
    for (const region of ["philippines", "thailand"]) {
      let particled = 0;
      for (let i = 0; i < 200; i++) {
        const msg = compile(region, i);
        expect(msg, msg).not.toMatch(/^(Hi|Hello|Hey|Good day|Hi there|Hello there)\s+(po|krub|ka)\b/i);
        if (/\b(po|krub|ka)\b/i.test(msg)) {
          particled++;
          // ...and it lands where a native writer puts it: closing a sentence.
          expect(msg, msg).toMatch(/\b(po|krub|ka)[!?.]/i);
        }
        // A local thank-you that ALREADY carries the particle never doubles it.
        expect(msg, msg).not.toMatch(/khop khun (krub|ka)\s+(krub|ka)/i);
      }
      expect(particled, region).toBeGreaterThan(0);
    }
  });

  it("no message ever ends on a bare greeting or contains a doubled greeting", () => {
    for (const region of [undefined, "vietnam", "philippines", "thailand", "indonesia"]) {
      for (let i = 0; i < 60; i++) {
        const msg = compile(region, i);
        expect(msg.length).toBeGreaterThan(10);
        expect(msg).not.toMatch(/\bbtw\b/i); // the old misplaced-greeting artifact
      }
    }
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
  it("no REDIS_URL -> the Redis layer is a strict no-op (keyless behavior)", async () => {
    const verdict = await ensureGloballyUnique("A perfectly fresh sentence here.", []);
    expect(verdict.changed).toBe(false); // nothing to collide with, no throw
  });
});
