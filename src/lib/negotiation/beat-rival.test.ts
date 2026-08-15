import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { beatRivalTarget, citesAMatch } from "./beat-rival";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// W5.1 - BEAT, NEVER MATCH.
//
// The owner read a live message that said "Could you match the 200 THB/day
// offer". A match hands over the traveller's strongest card - that a real
// competitor already quoted less - and the BEST outcome it can produce is the
// price they already had.
//
// The instruction was verbatim in three independent prompt builders, one of
// them modelled the match in its own few-shot, and the deterministic fallback
// asked for the rival's exact number. NOTHING inspected a draft for it: this
// codebase's own comments call prompt controls "advice, not a guarantee", and
// every "never match" control in the repo was advice.

describe("the ask is always strictly BELOW the rival", () => {
  it("never returns the rival's own number - that is the match", () => {
    for (const rival of [20, 99, 100, 167, 200, 250, 1200, 45_000]) {
      const ask = beatRivalTarget({ rivalPricePerDay: rival });
      expect(ask).toBeLessThan(rival);
      expect(ask).toBeGreaterThan(0);
    }
  });

  it("aims a real 5% under, not one unit under", () => {
    expect(beatRivalTarget({ rivalPricePerDay: 200 })).toBe(190);
  });

  it("cuts harder when THIS shop is barely above the rival", () => {
    // 210 quoted against a 200 rival: 0.85 * 210 = 179, well under the rival.
    expect(beatRivalTarget({ rivalPricePerDay: 200, quotePerDay: 210 })).toBe(179);
  });

  it("respects the market floor - no insulting lowball", () => {
    // 0.85 * 210 = 179 would be the ask; a real floor of 185 pulls it back up
    // and it is STILL strictly under the 200 rival.
    const ask = beatRivalTarget({ rivalPricePerDay: 200, quotePerDay: 210, floorPerDay: 185 });
    expect(ask).toBe(185);
    expect(ask).toBeLessThan(200);
  });

  it("...but a floor AT OR ABOVE the rival must never produce a match", () => {
    // The doctrine outranks the floor: a floor of 200 against a 200 rival
    // cannot be honoured while beating it, so the ask goes one unit under.
    expect(beatRivalTarget({ rivalPricePerDay: 200, floorPerDay: 200 })).toBe(199);
    expect(beatRivalTarget({ rivalPricePerDay: 200, floorPerDay: 260 })).toBe(199);
  });

  it("a nonsense rival yields no ask at all rather than a wrong one", () => {
    expect(beatRivalTarget({ rivalPricePerDay: 0 })).toBe(0);
    expect(beatRivalTarget({ rivalPricePerDay: Number.NaN })).toBe(0);
  });
});

describe("the rail recognises a match when it sees one", () => {
  it("catches the exact live failure", () => {
    expect(citesAMatch("Could you match the 200 THB/day offer?")?.rule).toBe("match");
  });

  it("catches the few-shot the prompt used to model", () => {
    expect(citesAMatch("another shop give me 200 per day, you can do same or better?")).toBeTruthy();
  });

  it("catches every phrasing the three prompt sites used to carry", () => {
    for (const s of [
      "can you match it?",
      "would you match that price",
      "ask them to match or beat it",
      "can you do the same price?",
      "could you give me the same?",
      "can you meet that price?",
      "anything equal to that would work",
      "if you can get close to 200 I book now",
    ]) {
      expect(citesAMatch(s), s).toBeTruthy();
    }
  });

  it("does NOT reject ordinary rental English", () => {
    // The near-misses that would make this rail unusable: every one of these is
    // a normal sentence in a rental chat and none of them asks for a match.
    for (const s of [
      "Is it the same bike as the photo?",
      "Same day pickup would be great!",
      "Can I return it the same place?",
      "Can you do 190 per day for the 3 days?",
      "Another shop offered 200 - could you do 185?",
      "Thanks! Any chance you can do a bit better for 3 days?",
      "I will take the same model as my friend rented",
    ]) {
      expect(citesAMatch(s), s).toBeNull();
    }
  });

  it("is quiet on empty input", () => {
    expect(citesAMatch("")).toBeNull();
    expect(citesAMatch("   ")).toBeNull();
  });
});

describe("all three prompt sites were actually rewritten", () => {
  // The finding that made this wave necessary: fixing agents.ts alone does NOT
  // fix the running engine, because the LIVE SPTE path composes its rival card
  // in negotiation/leverage. Three sites, one doctrine - pinned so a future
  // edit cannot restore "match or beat" in whichever one is not being read.
  const sites = {
    "leverage card (reaches the live engine via spte/pass)": "src/lib/negotiation/leverage.ts",
    "composeBargain system rule + user message + fallback pool": "src/lib/agents.ts",
  };
  for (const [label, path] of Object.entries(sites)) {
    it(`${label} no longer asks a shop to match`, () => {
      const src = read(path);
      expect(src).not.toMatch(/ask (?:this|them|THIS) shop to match or beat/i);
      expect(src).not.toMatch(/you can do same or better\?/i);
      expect(src).not.toMatch(/get close to \$\{/);
    });
  }

  it("the deterministic fallback never asks for the rival's exact number", () => {
    // `t ?? rival` was the whole bug: with no computed target the LLM-down
    // agent asked the shop for the rival's price, which is a match.
    const src = read("src/lib/agents.ts");
    expect(src).not.toMatch(/\$\{t \?\? rival\}/);
  });

  it("the rail runs on the finished draft, so the prompts are no longer advice", () => {
    const rails = read("src/lib/spte/rails.ts");
    expect(rails).toMatch(/citesAMatch/);
    expect(rails).toMatch(/beat-not-match/);
  });
});
