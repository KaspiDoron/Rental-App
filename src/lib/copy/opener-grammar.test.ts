import { describe, it, expect } from "vitest";
import { compileOpener } from "./promptCompiler";
import { drawStyle, SENTENCE_ORDERS, PLAIN_ASKS, ASK_PHRASINGS } from "./matrix";
import type { StructuredRFQ } from "../types";

// THE MESSAGE THE OWNER PHOTOGRAPHED:
//
//   "Can I ask your daily price? after an automatic scooter (125cc) for 3 days
//    straight."
//
// A sentence fragment, from a stranger, as a first contact. Two separate
// mistakes made it: every vehicle phrasing in the matrix is a VERB PHRASE
// ("after a scooter", "need a scooter") with no subject, and the
// `greet-ask-intro` branch used `s.selfIntro` as a BOOLEAN and threw its text
// away - so when the intro slot came up empty the predicate was dropped in
// bare, straight after a question mark.
//
// And underneath that, a smaller thing that matters more at scale: forty
// thousand combinations were all one of THREE shapes, which is what a
// fingerprint keys on far more than word choice.

const rfq = (over: Partial<StructuredRFQ> = {}): StructuredRFQ => ({
  vehicleClass: "scooter",
  engineSizeCc: 125,
  transmission: "automatic",
  durationDays: 3,
  accessories: [],
  fulfillment: "any",
  vendorMessage: "",
  ...over,
});

/** Every sentence in the message, terminator kept. */
const sentences = (text: string) => text.match(/[^.!?]+[.!?]+/g)?.map((s) => s.trim()) ?? [text];

/** A sentence with a verb but no subject, i.e. the defect. */
const FRAGMENT_LEAD =
  /^(after|need|want|looking|hoping|for)\b/i;

describe("no opener is a fragment, in any shape the matrix can draw", () => {
  it("REPRODUCTION: a predicate never follows a question mark bare", () => {
    // Exhaustive over the seed space that matters - the vendor id is what
    // varies within one batch, and the shapes cycle well inside 200.
    for (let i = 0; i < 200; i++) {
      const out = compileOpener(rfq(), { threadId: "t@example.com", vendorId: `v${i}`, nonce: 0 });
      for (const s of sentences(out)) {
        // Strip a leading emoji/particle noise before judging the first word.
        const first = s.replace(/^[^\p{L}]+/u, "");
        expect(FRAGMENT_LEAD.test(first), `${out}\n  -> fragment: "${s}"`).toBe(false);
      }
    }
  });

  it("the self-intro's TEXT is used, never as a mere boolean", () => {
    // `greet-ask-intro` rendered "(a scooter for 3 days)" when an intro
    // existed and dropped the fragment bare when it did not - discarding the
    // intro text in both branches.
    let sawIntroAfterAsk = false;
    for (let i = 0; i < 200; i++) {
      const seed = { threadId: "t@example.com", vendorId: `v${i}`, nonce: 0 };
      if (drawStyle(seed).order !== "greet-ask-intro") continue;
      const s = drawStyle(seed);
      if (!s.selfIntro) continue;
      const out = compileOpener(rfq(), seed);
      sawIntroAfterAsk = true;
      // Compare contraction-normalized: the `plain` style rewrites I'm -> I am
      // AFTER assembly, so the pool's literal text is not what lands.
      const norm = (x: string) => x.replace(/\bI'm\b/g, "I am");
      expect(norm(out)).toContain(norm(s.selfIntro));
      expect(out).not.toMatch(/\(\s*(after|need|looking|hoping|want)\b/i);
    }
    expect(sawIntroAfterAsk).toBe(true);
  });

  it("every phrasing carries the subject that fits IT", () => {
    // "I'm after" and "I need" do not take the same one, which is why a
    // single hard-coded prefix could never have fixed this.
    const subjects = new Set<string>();
    for (let i = 0; i < 200; i++) {
      subjects.add(drawStyle({ threadId: "t", vendorId: `v${i}`, nonce: 0 }).vehicleSubject);
    }
    expect(subjects).toEqual(new Set(["I", "I'm"]));
  });
});

describe("more shapes, because a shape is what a fingerprint sees", () => {
  it("there are five skeletons, not three", () => {
    expect(SENTENCE_ORDERS).toHaveLength(5);
    expect(SENTENCE_ORDERS).toContain("greet-detail-ask");
    expect(SENTENCE_ORDERS).toContain("intro-ask-plain");
  });

  it("and a batch actually draws more than three of them", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(drawStyle({ threadId: "t", vendorId: `v${i}`, nonce: 0 }).order);
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it("every skeleton still ends up asking for a price", () => {
    for (let i = 0; i < 200; i++) {
      const out = compileOpener(rfq(), { threadId: "t", vendorId: `v${i}`, nonce: 0 });
      expect(out, out).toMatch(/\?/);
      // 'What is the best you can do per day?' asks for a daily price
      // without using the word - the ask pool is idiomatic on purpose.
      expect(out.toLowerCase(), out).toMatch(/price|rate|much|cost|per day/);
    }
  });
});

describe("the register follows the reader", () => {
  const seed = (i: number) => ({ threadId: "t", vendorId: `v${i}`, nonce: 0 });

  it("a shop reading English as a second language gets plain words", () => {
    // "What's the best you can do per day?" is idiomatic, and to a counter
    // reading on a phone it is a puzzle. Same request, fewer meanings.
    for (let i = 0; i < 60; i++) {
      const s = drawStyle(seed(i), "thailand");
      expect(PLAIN_ASKS as readonly string[]).toContain(s.ask);
    }
  });

  it("and a native-English market keeps the idiomatic pool", () => {
    const asks = new Set<string>();
    for (let i = 0; i < 60; i++) asks.add(drawStyle(seed(i)).ask);
    expect([...asks].some((a) => (ASK_PHRASINGS as readonly string[]).includes(a))).toBe(true);
  });

  it("the local particle appears often enough to be a courtesy, not a rarity", () => {
    // The owner's decision: casual English WITH the particle. At ~1/3 most
    // messages to a Thai shop carried no krub/ka at all.
    let withParticle = 0;
    const N = 200;
    for (let i = 0; i < N; i++) if (drawStyle(seed(i), "thailand").particle) withParticle++;
    expect(withParticle / N).toBeGreaterThan(0.4);
  });

  it("...and it is still gender-STABLE per thread, never flipping mid-hunt", () => {
    const a = drawStyle({ threadId: "t", vendorId: "v1", nonce: 0 }, "thailand");
    const b = drawStyle({ threadId: "t", vendorId: "v1", nonce: 7 }, "thailand");
    if (a.particle && b.particle) expect(a.particle).toBe(b.particle);
  });

  it("a region with no particle never borrows another's", () => {
    for (let i = 0; i < 60; i++) {
      expect(drawStyle(seed(i), "vietnam").particle).toBeUndefined();
      expect(drawStyle(seed(i), "indonesia").particle).toBeUndefined();
    }
  });
});
