import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../runtime-config", () => ({
  getConfig: vi.fn(async () => null),
  setConfig: vi.fn(async () => {}),
  sbSelect: vi.fn(async () => []),
}));

import {
  compileOpsLearning,
  formatDirectorLearning,
  formatJudgeCalibration,
  type ReviewSample,
} from "./learning";

const R = (over: Partial<ReviewSample>): ReviewSample => ({
  edge_id: null,
  branch_correct: null,
  outcome_impact: null,
  rating: null,
  verdict: null,
  feedback: null,
  tags: null,
  ...over,
});

describe("compileOpsLearning", () => {
  it("emits no prior line below the 3-sample threshold", () => {
    const out = compileOpsLearning(
      [
        R({ edge_id: "d-bargain", branch_correct: true }),
        R({ edge_id: "d-bargain", branch_correct: true }),
      ],
      [],
      "t"
    );
    expect(out.edgePriorLines).toEqual([]);
  });

  it("aggregates branch verdicts + outcome impacts per edge", () => {
    const reviews = [
      R({ edge_id: "d-bargain", branch_correct: true, outcome_impact: "improved" }),
      R({ edge_id: "d-bargain", branch_correct: true, outcome_impact: "improved" }),
      R({ edge_id: "d-bargain", branch_correct: false, outcome_impact: "worsened" }),
    ];
    const out = compileOpsLearning(reviews, [], "t");
    expect(out.edgePriorLines).toHaveLength(1);
    expect(out.edgePriorLines[0]).toContain("edge d-bargain");
    expect(out.edgePriorLines[0]).toContain("owner-correct 2/3");
    expect(out.edgePriorLines[0]).toContain("improved 2x");
    expect(out.edgePriorLines[0]).toContain("worsened 1x");
  });

  it("accepts the PRIMARY engine's spte:<move> identity - live traffic compiles", () => {
    // WAVE 3 defect 6: SPTE stamps `spte:<move>` as its edge_id (live.ts).
    // Before, the compiler only ever saw graph edge ids, and since SPTE wrote
    // no edge_id at all, every production review was dropped and edgePriorLines
    // was structurally dead on live traffic.
    const reviews = [
      R({ edge_id: "spte:bargain", branch_correct: true, outcome_impact: "improved" }),
      R({ edge_id: "spte:bargain", branch_correct: true }),
      R({ edge_id: "spte:bargain", branch_correct: false, outcome_impact: "worsened" }),
    ];
    const out = compileOpsLearning(reviews, [], "t");
    expect(out.edgePriorLines).toHaveLength(1);
    expect(out.edgePriorLines[0]).toContain("move bargain (primary engine)");
    expect(out.edgePriorLines[0]).toContain("owner-correct 2/3");
  });

  it("caps priors at 6 lines, exemplars at 2, calibration at 3", () => {
    const reviews = Array.from({ length: 40 }, (_, i) =>
      R({ edge_id: `e${i % 10}`, branch_correct: true, rating: 1, feedback: "too weak", verdict: "reject" })
    );
    const training = Array.from({ length: 6 }, (_, i) => ({
      text: `exemplar ${i}`,
      source: "ops-exemplar",
    }));
    const out = compileOpsLearning(reviews, training, "t");
    expect(out.edgePriorLines.length).toBeLessThanOrEqual(6);
    expect(out.directorExemplars).toHaveLength(2);
    expect(out.judgeCalibration.length).toBeLessThanOrEqual(3);
  });

  it("only ops-sourced training rows become director exemplars", () => {
    const out = compileOpsLearning(
      [],
      [
        { text: "owner-taught transcript", source: "text" },
        { text: "ops correction", source: "ops-correction" },
      ],
      "t"
    );
    expect(out.directorExemplars).toEqual(["ops correction"]);
  });

  it("prefers calibration-gap tagged reviews for judge calibration", () => {
    const out = compileOpsLearning(
      [
        R({ rating: 5, feedback: "great close", verdict: "approve" }),
        R({ rating: 3, feedback: "judge said 5, this was mediocre", tags: ["calibration-gap"] }),
      ],
      [],
      "t"
    );
    expect(out.judgeCalibration[0]).toContain("judge said 5");
  });
});

describe("prompt blocks - the byte-identical guarantee", () => {
  it("null learning adds NOTHING to either prompt", () => {
    // The core safety property: with no compiled learning (or the kill switch
    // off, which makes getOpsLearning return null) the director and judge
    // prompts are byte-identical to the pre-Ops-Center build.
    expect(formatDirectorLearning(null)).toBe("");
    expect(formatJudgeCalibration(null)).toBe("");
  });

  it("empty blob also adds nothing", () => {
    const empty = { compiledAt: "t", edgePriorLines: [], directorExemplars: [], judgeCalibration: [] };
    expect(formatDirectorLearning(empty)).toBe("");
    expect(formatJudgeCalibration(empty)).toBe("");
  });

  it("filled blob renders labeled sections with the legal-moves guard", () => {
    const block = formatDirectorLearning({
      compiledAt: "t",
      edgePriorLines: ["edge d-bargain: owner-correct 5/6, outcome improved 4x"],
      directorExemplars: ["Shop held firm, agent pivoted to weekly rate - won 20% off"],
      judgeCalibration: [],
    });
    expect(block).toContain("HISTORICAL EDGE PERFORMANCE");
    expect(block).toContain("owner-correct 5/6");
    expect(block).toContain("EXEMPLARS");
    expect(block).toContain("never pick a move outside LEGAL MOVES");
  });
});
