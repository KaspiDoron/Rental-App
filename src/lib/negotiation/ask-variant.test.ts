import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { askVariantFor, ASK_VARIANT_SPLIT, askVariantDirective, variantHonoured, ASK_VARIANTS } from "./ask-variant";
import { compileAskVariantReport, type VariantTurn } from "../ops/ask-variant-stats";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// W5.4 - THE A/B THE OWNER ASKED FOR.
//
// "I want to measure the times of successful bargain that we suggested a lower
// price (we gave them a specific number) Vs the times of successful bargaining
// that we didn't gave them a specific price and just asked for a lower price
// than X (in both ways we write them the high price we already have 'X')."
//
// Everything the measurement needed already existed except the LABEL:
// learnFromReply is a precise one-turn-late concession detector with one live
// caller, and what it credits is the MOVE NAME ("bargain") - identical in both
// arms, so the two phrasings were pooled into one indistinguishable statistic.

describe("assignment is per THREAD, and stable", () => {
  it("the same thread always lands in the same arm", () => {
    for (const key of ["a@b.com:66812345678", "x@y.z:60112223333", "q@r.s:1"]) {
      const first = askVariantFor(key);
      for (let i = 0; i < 50; i++) expect(askVariantFor(key)).toBe(first);
    }
  });

  it("THE BETA PIN: every thread gets the specific-number arm while the split is off", () => {
    // The owner's launch requirement is a specific sentence ("...can you offer
    // 180?"), and the open-ended arm forbids naming that figure - so a 50/50
    // split would silence the product's strongest move on half of all threads,
    // for a sample far too small to settle the question. The experiment is
    // paused, not deleted.
    expect(ASK_VARIANT_SPLIT).toBe(false);
    const arms = new Set(
      Array.from({ length: 40 }, (_, i) => askVariantFor(`traveller@example.com:6681234${1000 + i}`))
    );
    expect(arms).toEqual(new Set(["specific-number"]));
  });

  it("...and the hashing that WILL split per thread is still intact underneath", () => {
    // The cohort bug this design avoids: lib/cohort buckets per identity, which
    // would put a traveller's whole twelve-shop hunt in one arm. The unit of a
    // bargaining phrasing is the negotiation. Assert the hash still separates
    // threads, so flipping the flag restores a real experiment.
    const src = readFileSync(join(process.cwd(), "src/lib/negotiation/ask-variant.ts"), "utf8");
    expect(src).toMatch(/hash\(key\) % 2 === 0 \? "specific-number" : "open-ended-below"/);
    // The pin is ONE line above it and nothing else was removed - both arms and
    // both directives survive, so the flag is a real switch, not a rewrite.
    expect(src).toMatch(/if \(!ASK_VARIANT_SPLIT\) return "specific-number";/);
    expect(ASK_VARIANTS).toContain("open-ended-below");
    expect(askVariantDirective("open-ended-below", {})).toMatch(/do NOT name a counter-price/);
  });

  it("an unkeyed turn is not an experiment subject - it keeps the old behaviour", () => {
    expect(askVariantFor("")).toBe("specific-number");
  });
});

describe("BOTH arms state the price we already have - the owner's control", () => {
  it("the specific arm names our counter AND their number", () => {
    const d = askVariantDirective("specific-number", { quotePerDay: 300, currency: "THB", target: 210 });
    expect(d).toContain("300");
    expect(d).toContain("210");
  });

  it("the open-ended arm names their number and REFUSES to name ours", () => {
    const d = askVariantDirective("open-ended-below", { quotePerDay: 300, currency: "THB", target: 210 });
    expect(d).toContain("300");
    expect(d).not.toContain("210");
    expect(d).toMatch(/do NOT name a counter-price/i);
  });
});

describe("a draft that ignored its arm is visible, not silently averaged in", () => {
  it("naming a number in the open-ended arm is off-arm", () => {
    expect(variantHonoured("open-ended-below", 210)).toBe(false);
    expect(variantHonoured("open-ended-below", undefined)).toBe(true);
  });
  it("naming NO number in the specific arm is off-arm", () => {
    expect(variantHonoured("specific-number", undefined)).toBe(false);
    expect(variantHonoured("specific-number", 210)).toBe(true);
  });
});

describe("the report attributes a concession to the arm that earned it", () => {
  const turn = (over: Partial<VariantTurn>): VariantTurn => ({
    userEmail: "t@x.com",
    vendorId: "shop-a",
    createdAt: "2026-08-15T10:00:00Z",
    move: "bargain",
    ...over,
  });

  it("a shop that came down credits the arm the push was written in", () => {
    const r = compileAskVariantReport([
      turn({ askVariant: "specific-number", standingQuote: 300, variantOk: true }),
      turn({ createdAt: "2026-08-15T10:05:00Z", move: "present", quote: 240 }),
    ]);
    const specific = r.arms.find((a) => a.variant === "specific-number")!;
    expect(specific.attempts).toBe(1);
    expect(specific.concessions).toBe(1);
    expect(specific.medianConcessionPct).toBe(20);
  });

  it("a shop that held firm is an attempt, not a concession", () => {
    const r = compileAskVariantReport([
      turn({ askVariant: "open-ended-below", standingQuote: 300 }),
      turn({ createdAt: "2026-08-15T10:05:00Z", move: "present", quote: 300 }),
    ]);
    const open = r.arms.find((a) => a.variant === "open-ended-below")!;
    expect(open.attempts).toBe(1);
    expect(open.concessions).toBe(0);
    expect(open.successPct).toBe(0);
  });

  it("a bargain the shop never answered is UNSCORED, not a loss", () => {
    // Counting it would systematically punish whichever arm was sent most
    // recently - a bias that grows with traffic.
    const r = compileAskVariantReport([turn({ askVariant: "specific-number", standingQuote: 300 })]);
    expect(r.samples).toBe(0);
  });

  it("another THREAD's concession never credits this thread's arm", () => {
    const r = compileAskVariantReport([
      turn({ askVariant: "specific-number", standingQuote: 300 }),
      turn({ vendorId: "shop-b", createdAt: "2026-08-15T10:05:00Z", move: "present", quote: 120 }),
    ]);
    expect(r.samples).toBe(0);
  });

  it("a price that went UP is not a loss for the phrasing", () => {
    const r = compileAskVariantReport([
      turn({ askVariant: "specific-number", standingQuote: 300 }),
      turn({ createdAt: "2026-08-15T10:05:00Z", move: "present", quote: 400 }),
    ]);
    expect(r.samples).toBe(0);
  });

  it("holds its verdict until both arms have a real sample", () => {
    const thin = compileAskVariantReport([
      turn({ askVariant: "specific-number", standingQuote: 300 }),
      turn({ createdAt: "2026-08-15T10:05:00Z", move: "present", quote: 240 }),
    ]);
    expect(thin.verdict).toBeNull();
  });

  it("calls a winner once both arms are populated", () => {
    const rows: VariantTurn[] = [];
    const push = (i: number, arm: string, after: number) => {
      rows.push(
        turn({ vendorId: `v${arm}${i}`, askVariant: arm, standingQuote: 300, createdAt: `2026-08-15T10:00:0${i % 10}Z` }),
        turn({ vendorId: `v${arm}${i}`, createdAt: `2026-08-15T11:00:0${i % 10}Z`, move: "present", quote: after })
      );
    };
    // Specific wins 100%, open-ended wins 0% - 25 samples each.
    for (let i = 0; i < 25; i++) push(i, "specific-number", 240);
    for (let i = 0; i < 25; i++) push(i, "open-ended-below", 300);
    const r = compileAskVariantReport(rows);
    expect(r.samples).toBe(50);
    expect(r.verdict).toMatch(/specific number wins 100 points more often/i);
  });

  it("counts off-arm drafts so a contaminated sample is readable", () => {
    const r = compileAskVariantReport([
      turn({ askVariant: "open-ended-below", standingQuote: 300, variantOk: false }),
      turn({ createdAt: "2026-08-15T10:05:00Z", move: "present", quote: 240 }),
    ]);
    expect(r.arms.find((a) => a.variant === "open-ended-below")!.offArm).toBe(1);
  });

  it("materialDrop is NOT the concession signal", () => {
    // It flags a session-wide low, which can be a DIFFERENT shop entirely -
    // using it would credit this thread's phrasing for another thread's win.
    expect(read("src/lib/ops/ask-variant-stats.ts")).toMatch(/DELIBERATELY NOT `materialDrop`/);
    expect(read("src/lib/ops/ask-variant-stats.ts")).not.toMatch(/\.materialDrop/);
  });
});

describe("the label reaches the places that can use it", () => {
  it("the arm is stamped on the OUTBOUND row - the join attribution needs", () => {
    const live = read("src/lib/spte/live.ts");
    expect(live).toMatch(/askVariant,/);
    expect(live).toMatch(/counterPricePerDay: outcome\.artifact\.counterPricePerDay/);
  });

  it("learnFromReply credits the arm as well as the move", () => {
    const outcomes = read("src/lib/learning/outcomes.ts");
    expect(outcomes).toMatch(/askVariant\?: string \| null/);
    expect(outcomes).toMatch(/recordOutcome\(`\$\{tacticId\}#\$\{arm\}`/);
    // The move-level statistic every existing panel reads must not move.
    expect(outcomes).toMatch(/recordOutcome\(tacticId, result\.won, result\.discountPct\)/);
  });

  it("the last-move read carries the arm off the same row as the move", () => {
    expect(read("src/lib/learning/last-move.ts")).toMatch(/askVariant\?: string/);
  });

  it("the prompt actually asks for the assigned shape", () => {
    const pass = read("src/lib/spte/pass.ts");
    expect(pass).toMatch(/const askVariant = askVariantFor\(ctx\.thread\.threadKey\)/);
    expect(pass).toMatch(/askVariantDirective\(askVariant, \{/);
  });

  it("the rival card does not name a number the open-ended arm forbids", () => {
    // Two halves of one prompt contradicting each other is not an experiment.
    // BEAT-NEVER-MATCH still holds in both arms - only the naming differs.
    const pass = read("src/lib/spte/pass.ts");
    expect(pass).toMatch(/nameATarget: askVariant !== "open-ended-below"/);
    const lev = read("src/lib/negotiation/leverage.ts");
    expect(lev).toMatch(/input\.nameATarget === false/);
    expect(lev).toMatch(/ask THIS shop to go BELOW that number/);
  });

  it("the Ops card renders both arms", () => {
    const panel = read("src/components/ops/AnalyticsPanel.tsx");
    expect(panel).toMatch(/Specific number vs open-ended/);
    expect(panel).toMatch(/Median cut when it worked/);
  });
});
