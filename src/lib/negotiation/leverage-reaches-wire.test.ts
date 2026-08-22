import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// OWNER REPORT 8, B1 - the owner's product requirement:
//   "We've received an offer of 200 from another rental shop. Can you offer 180?"
//
// The machinery was genuinely built and genuinely wired. Four things stopped it
// reaching the shop.

describe("the cheapest rival survives truncation", () => {
  const engine = read("src/lib/graph/engine.ts");

  it("THE REGRESSION: sessionTable sorts before it slices", () => {
    // `[...rows.values()].slice(0, 10)` on a Map in INSERTION order meant that
    // in any hunt over ten shops the cheapest quote could fall off the end
    // before validRivals ever saw it - and the cheapest quote is the whole
    // point of the leverage card.
    expect(engine).not.toMatch(/return \[\.\.\.rows\.values\(\)\]\.slice\(0, 10\);/);
    expect(engine).toMatch(/const ranked = \[\.\.\.rows\.values\(\)\]\.sort/);
    // The truncation is no longer a bare `ranked.slice(0, 10)`. Owner report 9
    // found that sorting cheapest-first fixed the leverage card and starved the
    // sibling re-bargain in the same stroke - it reads this same list and sorts
    // it DEAREST-first, so the slice was discarding exactly its targets. The
    // cap is spent from both ends now. What this test guards - that the list is
    // RANKED before it is cut, and that the cheapest survives - is unchanged,
    // and the EXECUTED case below is what actually proves it.
    expect(engine).toMatch(/const head = ranked\.slice\(0, SESSION_TABLE_CAP - REBARGAIN_TAIL\);/);
    expect(engine).toMatch(/const tail = ranked\.slice\(-REBARGAIN_TAIL\);/);
  });

  it("this shop is kept regardless - the comparison needs its own row", () => {
    const blk = engine.slice(engine.indexOf("SORT BEFORE YOU TRUNCATE"));
    expect(blk.slice(0, 1600)).toMatch(/a\.isThisShop !== b\.isThisShop/);
  });

  it("priced rows rank ahead of priceless ones, then cheapest first", () => {
    const blk = engine.slice(engine.indexOf("SORT BEFORE YOU TRUNCATE"));
    expect(blk.slice(0, 1600)).toMatch(/if \(ap !== bp\) return ap \? -1 : 1;/);
    expect(blk.slice(0, 1600)).toMatch(/\(a\.pricePerDay as number\) - \(b\.pricePerDay as number\)/);
  });

  it("EXECUTED: a 12-shop board keeps the cheapest even when it sorts last", () => {
    // Model the exact shape: insertion order puts the cheapest 11th.
    type Row = { vendorId: string; pricePerDay?: number; isThisShop?: boolean };
    const rows: Row[] = [{ vendorId: "self", pricePerDay: 300, isThisShop: true }];
    for (let i = 0; i < 10; i++) rows.push({ vendorId: `v${i}`, pricePerDay: 250 + i });
    rows.push({ vendorId: "CHEAPEST", pricePerDay: 200 });
    const ranked = rows.slice().sort((a, b) => {
      if (a.isThisShop !== b.isThisShop) return a.isThisShop ? -1 : 1;
      const ap = typeof a.pricePerDay === "number" && a.pricePerDay > 0;
      const bp = typeof b.pricePerDay === "number" && b.pricePerDay > 0;
      if (ap !== bp) return ap ? -1 : 1;
      if (ap && bp) return (a.pricePerDay as number) - (b.pricePerDay as number);
      return 0;
    });
    const kept = ranked.slice(0, 10).map((r) => r.vendorId);
    expect(kept, "the 200 must survive a 10-row cap").toContain("CHEAPEST");
    expect(kept, "...and so must our own row").toContain("self");
    // The old behaviour, for contrast: unsorted insertion order drops it.
    expect(rows.slice(0, 10).map((r) => r.vendorId)).not.toContain("CHEAPEST");
  });
});

describe("a bargain that ignores the rival is REJECTED, not sent", () => {
  const rails = read("src/lib/spte/rails.ts");

  it("THE MISSING GUARANTEE: there is now a cite-the-rival rail", () => {
    // Every other control was prompt text - and this file's own doctrine says
    // "a prompt is advice and a rail is a guarantee". beat-not-match got a
    // rail; cite-the-rival did not.
    expect(rails).toMatch(/rule: "cite-the-rival"/);
    expect(rails).toMatch(/cheapestCheaperRival\(ctx\.session\.rivals, quoteOnTable\(ctx\)\)/);
  });

  it("it only binds when a cheaper rival actually exists", () => {
    const blk = rails.slice(rails.indexOf("CITE THE RIVAL"));
    expect(blk.slice(0, 2400)).toMatch(/if \(rival\) \{/);
  });

  it("a draft that already names the number passes untouched", () => {
    const blk = rails.slice(rails.indexOf("CITE THE RIVAL"));
    expect(blk.slice(0, 3600)).toMatch(/if \(!cited\)/);
  });

  it("ANY real rival counts, not only the cheapest", () => {
    // Requiring the cheapest specifically would reject "another shop quoted me
    // 280 - can you beat it?" on a board that also holds a 250 - good leverage,
    // already validated as real by checkOutboundNumbers.
    const blk = rails.slice(rails.indexOf("CITE THE RIVAL"));
    expect(blk.slice(0, 3600)).toMatch(/ANY REAL RIVAL COUNTS/);
    expect(blk.slice(0, 3600)).toMatch(/quotable\.some\(\(q\) => Math\.abs\(n - Math\.round\(q\)\) <= 1\)/);
  });

  it("it runs AFTER send-worthiness - an empty draft is diagnosed as empty", () => {
    // "thanks! 👍" is empty before it is leverage-free; naming the shallower
    // defect first would hide the real one behind a confusing reason.
    const sw = rails.indexOf('rule: "send-worthiness"');
    const cite = rails.indexOf('rule: "cite-the-rival"');
    expect(sw).toBeGreaterThan(0);
    expect(cite).toBeGreaterThan(sw);
  });

  it("rejection lands on the template that DOES cite it", () => {
    // The failure mode of this rail is the message the owner asked for.
    const pass = read("src/lib/spte/pass.ts");
    expect(pass).toMatch(/Another shop offered \$\{money\(rival\.pricePerDay\)\}/);
  });
});

describe("the owner's sentence is not suppressed on half the threads", () => {
  it("THE CONTRADICTION: the A/B split is pinned off for the beta", () => {
    const av = read("src/lib/negotiation/ask-variant.ts");
    expect(av).toMatch(/export const ASK_VARIANT_SPLIT = false;/);
    expect(av).toMatch(/if \(!ASK_VARIANT_SPLIT\) return "specific-number";/);
  });

  it("...but the experiment is paused, not deleted", () => {
    const av = read("src/lib/negotiation/ask-variant.ts");
    expect(av).toMatch(/hash\(key\) % 2 === 0/);
    expect(av).toMatch(/open-ended-below/);
  });
});

describe("citedRival measures the wire, not the model's self-report", () => {
  const live = read("src/lib/spte/live.ts");

  it("THE BROKEN INSTRUMENT: it no longer reads leverageUsed", () => {
    // leverageUsed is written by the model about itself, unvalidated - and
    // fallbackArtifact hard-codes it to [], so the one path that cites the
    // rival deterministically always recorded false.
    expect(live).not.toMatch(/citedRival: Boolean\(outcome\.artifact\.leverageUsed\?\.includes\("rival"\)\)/);
    expect(live).toMatch(/citedRival: \(\(\) => \{/);
  });

  it("it checks the SENT text against the cheapest rival's number", () => {
    const blk = live.slice(live.indexOf("MEASURED ON THE WIRE"));
    expect(blk.slice(0, 1800)).toMatch(/cheapestCheaperRival\(tc\.session\.rivals, quoteOnTable\(tc\)\)/);
    expect(blk.slice(0, 1800)).toMatch(/if \(!rival \|\| !send\) return false;/);
  });

  it("EXECUTED: the tolerance matches how a composer really writes a price", () => {
    const cited = (send: string, target: number) =>
      (send.match(/\d[\d,.]*/g) ?? []).some((n) => {
        const v = Number(n.replace(/[,.](?=\d{3}\b)/g, "").replace(/,/g, "."));
        return Number.isFinite(v) && Math.abs(v - target) <= 1;
      });
    expect(cited("Another shop offered 200/day - could you do 180?", 200)).toBe(true);
    expect(cited("another shop quoted 1,200 - can you beat it?", 1200)).toBe(true);
    expect(cited("they said 201 baht", 200)).toBe(true); // rounding tolerance
    expect(cited("Any chance of a better daily rate for the scooter?", 200)).toBe(false);
    expect(cited("we can do 350 for you", 200)).toBe(false);
  });
});
