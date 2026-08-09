import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  batchProgress,
  stallOf,
  SEGMENT_ONE_PCT,
  LIVE_CEILING_PCT,
  type BatchProgressInput,
} from "./progress";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const input = (over: Partial<BatchProgressInput> = {}): BatchProgressInput => ({
  selected: 10,
  reached: 0,
  quoted: 0,
  negotiating: 0,
  queued: 10,
  introRemaining: 10,
  health: "healthy",
  ...over,
});

// A FIFTH NUMBER THAT DISAGREES WITH THE OTHER FOUR.
//
// Part 5.5 found four live derivations of "how many shops have been contacted"
// plus a fifth dead one, with page.tsx rendering Math.max() of two of them. A
// progress bar is the most-watched surface in the app; computed client-side it
// would make that defect worse and put it where everyone looks.

describe("the two segments", () => {
  it("segment 1 is shops reached over shops selected, and it owns 0-60%", () => {
    expect(batchProgress(input({ reached: 0, queued: 10 })).pct).toBe(0);
    expect(batchProgress(input({ reached: 5, queued: 5 })).pct).toBe(SEGMENT_ONE_PCT / 2);
    expect(batchProgress(input({ reached: 10, queued: 0 })).pct).toBe(SEGMENT_ONE_PCT);
  });

  it("segment 2 is quotes over shops REACHED, and it owns 60-100%", () => {
    const p = batchProgress(input({ reached: 10, queued: 0, quoted: 5 }));
    expect(p.pct).toBe(SEGMENT_ONE_PCT + (100 - SEGMENT_ONE_PCT) / 2);
    expect(p.segment).toBe(2);
  });

  it("segment 2 keeps moving after segment 1 is full", () => {
    // Dispatch finishing is not the same as the price being found, and a bar
    // that stops when the last message leaves says exactly the wrong thing at
    // the moment the interesting half starts.
    const seq = [0, 2, 5, 8, 10].map(
      (q) => batchProgress(input({ reached: 10, queued: 0, quoted: q })).pct
    );
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThan(seq[i - 1]);
  });

  it("segment 2's denominator is shops REACHED, not shops selected", () => {
    // Four shops reached and all four quoting is a complete second segment -
    // 24 + 40 = 64. Against the selection it would read 24 + 16 = 40, which
    // would mark a finished negotiation phase as barely started because six
    // shops had no phone number.
    const p = batchProgress(input({ selected: 10, reached: 4, queued: 0, quoted: 4 }));
    expect(p.pct).toBe(64);
  });

  it("a silent shop holds the bar honestly, and the label says why", () => {
    // Six of ten reached shops never answering IS unfinished work, so the bar
    // must not pretend otherwise. What it must not do is look stuck: the
    // sentence beside it names the wait instead of leaving a frozen number to
    // be read as a broken app.
    const p = batchProgress(input({ selected: 10, reached: 10, queued: 0, quoted: 4 }));
    expect(p.pct).toBeLessThan(100);
    expect(p.pct).toBeGreaterThan(SEGMENT_ONE_PCT);
    expect(p.stall).toBe("awaiting-shops");
    expect(p.label).toMatch(/waiting on the rest/i);
  });

  it("is monotone in every input", () => {
    let prev = -1;
    for (let reached = 0; reached <= 10; reached++) {
      const pct = batchProgress(input({ reached, queued: 10 - reached })).pct;
      expect(pct).toBeGreaterThanOrEqual(prev);
      prev = pct;
    }
    prev = -1;
    for (let quoted = 0; quoted <= 10; quoted++) {
      const pct = batchProgress(input({ reached: 10, queued: 0, quoted })).pct;
      expect(pct).toBeGreaterThanOrEqual(prev);
      prev = pct;
    }
  });
});

describe("the bar is NEVER 100% while work is live", () => {
  it("a live negotiation caps it below full", () => {
    const p = batchProgress(input({ reached: 10, queued: 0, quoted: 10, negotiating: 2 }));
    expect(p.pct).toBe(LIVE_CEILING_PCT);
  });

  it("a queued message caps it below full", () => {
    expect(batchProgress(input({ reached: 9, queued: 1, quoted: 9 })).pct).toBeLessThan(100);
  });

  it("100% means genuinely finished - reached, quoted, nothing in flight", () => {
    expect(
      batchProgress(input({ selected: 4, reached: 4, queued: 0, quoted: 4, negotiating: 0 })).pct
    ).toBe(100);
  });
});

describe("the three stop states", () => {
  it("HELD ON THE ALLOWANCE: the bar stops and says so, it does not creep", () => {
    const held = input({ reached: 6, queued: 4, introRemaining: 0 });
    const p = batchProgress(held);
    expect(p.stall).toBe("intro-budget");
    // Frozen exactly at segment 1's honest position - no phantom advance.
    expect(p.pct).toBe(Math.round(SEGMENT_ONE_PCT * 0.6));
    expect(p.label).toMatch(/allowance/i);
  });

  it("COLD HELD: the copy is about replies, never about bans", () => {
    // Constraint 5. A restriction rendered to the traveller in ban language is
    // a support ticket and a broken trust promise.
    for (const health of ["paused", "recovering"] as const) {
      const p = batchProgress(input({ reached: 6, queued: 4, health }));
      expect(p.stall).toBe("cold-held");
      expect(p.label).toMatch(/Waiting on replies before opening more conversations/);
      expect(p.label).not.toMatch(/ban|restrict|block|flag|spam|risk/i);
    }
  });

  it("a health hold outranks a budget hold - only one of them clears on a clock", () => {
    expect(stallOf(input({ reached: 6, queued: 4, introRemaining: 0, health: "paused" }))).toBe(
      "cold-held"
    );
  });

  it("AWAITING SHOPS: every shop reached, the wait is now entirely on them", () => {
    const p = batchProgress(input({ reached: 10, queued: 0 }));
    expect(p.stall).toBe("awaiting-shops");
    expect(p.label).toMatch(/waiting for the first replies/i);
  });

  it("AN UNREADABLE BUDGET IS NOT A HOLD", () => {
    // Fail-dark means say nothing, not invent a reason. Reading null as "zero
    // remaining" is the fail-green defect of Part 9.2 with its sign flipped -
    // it would announce a hold that is not happening.
    expect(stallOf(input({ reached: 6, queued: 4, introRemaining: null }))).toBe("none");
  });

  it("no hold is claimed when nothing is queued", () => {
    expect(stallOf(input({ reached: 10, queued: 0, introRemaining: 0, health: "paused" }))).toBe(
      "awaiting-shops"
    );
  });
});

describe("the copy is whole sentences with placeholders", () => {
  it("every label carries its numbers as vars, never glued to a fragment", () => {
    // Part 5.3: number-plus-fragment concatenation does not survive Hebrew or
    // RTL. The sentence has to be one translatable unit.
    const cases: BatchProgressInput[] = [
      input({ reached: 3, queued: 7 }),
      input({ reached: 6, queued: 4, introRemaining: 0 }),
      input({ reached: 6, queued: 4, health: "paused" }),
      input({ reached: 10, queued: 0 }),
      input({ reached: 10, queued: 0, quoted: 3 }),
      input({ reached: 10, queued: 0, quoted: 3, negotiating: 4 }),
    ];
    for (const c of cases) {
      const p = batchProgress(c);
      const holes = [...p.label.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(holes.length).toBeGreaterThan(0);
      for (const h of holes) expect(p.vars).toHaveProperty(h);
      // A whole sentence, not a fragment.
      expect(p.label.trim()).toMatch(/[.!?]$/);
      // Only short hyphens.
      expect(p.label).not.toMatch(/[‐-―]/);
    }
  });
});

describe("total on nonsense input - a bar must never break the poll", () => {
  it("an empty selection is 0%, not NaN", () => {
    const p = batchProgress(input({ selected: 0, reached: 0, queued: 0 }));
    expect(p.pct).toBe(0);
    expect(Number.isFinite(p.pct)).toBe(true);
  });

  it("counts above their own denominator are clamped, never rendered as 11 of 10", () => {
    // These come from independent reads that can disagree by a row across a
    // poll boundary.
    const p = batchProgress(input({ selected: 10, reached: 14, quoted: 20, negotiating: 30, queued: 0 }));
    expect(p.reached).toBe(10);
    expect(p.quoted).toBe(10);
    expect(p.negotiating).toBe(10);
    expect(p.pct).toBeLessThanOrEqual(100);
  });

  it("negative and fractional counts resolve rather than throw", () => {
    const p = batchProgress(input({ selected: -3, reached: -1, quoted: 2.7, queued: -5 }));
    expect(p.pct).toBe(0);
    expect(p.selected).toBe(0);
  });
});

describe("DURATION IS NEVER A CONSTANT", () => {
  it("the module contains no hardcoded batch duration", () => {
    // Part 11 F1: free tier finishes in ~20-25 min and a full 24-shop batch
    // runs 55-105. A bar paced against a hardcoded hour sits at 40% while a
    // free batch is already done.
    const code = readCode("src/lib/progress.ts");
    expect(code).not.toMatch(/60\s*\*\s*60\s*\*\s*1000/);
    expect(code).not.toMatch(/3_600_000|3600000/);
    expect(code).not.toMatch(/DURATION_M(IN|S)\s*=/);
  });

  it("the ETA is passed through from the computed schedule, or absent", () => {
    expect(batchProgress(input({ etaDoneBy: "2026-08-09T12:00:00.000Z" })).etaDoneBy).toBe(
      "2026-08-09T12:00:00.000Z"
    );
    expect(batchProgress(input()).etaDoneBy).toBeNull();
  });
});

describe("ONE DERIVATION - the server computes it, the client renders it", () => {
  const route = readCode("src/app/api/activity/route.ts");

  it("the activity route computes the bar and ships it as one field", () => {
    expect(route).toMatch(/batchProgress\(/);
    expect(route).toMatch(/\bprogress,/);
  });

  it("it is built on the SAME rollup every card and counter reads", () => {
    // Not a parallel count of its own. vendorStates is the authoritative rung.
    const block = route.slice(route.indexOf("batchProgress({") - 1500, route.indexOf("batchProgress({") + 700);
    expect(block).toMatch(/vendorStates/);
  });

  it("the page passes the object straight through - it does no arithmetic on it", () => {
    const page = readCode("src/app/page.tsx");
    expect(page).toMatch(/<BatchProgressBar progress=\{progress\}/);
    // The page must not touch the numbers. `Math.max()` of two derivations on
    // one surface is the exact defect this module exists to prevent, and it
    // already shipped once.
    expect(page).not.toMatch(/progress\.(pct|reached|quoted)\s*[*+/-]/);
    expect(page).not.toMatch(/Math\.max\([^)]*progress\./);
  });

  it("the component renders the server's number and derives none of its own", () => {
    const bar = readCode("src/components/BatchProgressBar.tsx");
    expect(bar).toMatch(/const \{ pct, stall, reached, selected, quoted \} = progress;/);
    // Segment widths are laid out from the same pct, not recomputed from raw
    // counts by a second formula that could disagree with the first.
    expect(bar).toMatch(/pct - seg1Width/);
    expect(bar).toMatch(/SEGMENT_ONE_PCT/);
  });
});
