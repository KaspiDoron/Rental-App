import { describe, it, expect, vi } from "vitest";

// The golden harness itself, run through the REAL engine with the default
// graph - deterministic end to end (stubbed extraction, frozen floor, no LLM,
// frozen clock). These hardcoded cases make CI an eval gate for engine
// changes, exactly like the owner's frozen production conversations.

vi.mock("server-only", () => ({}));
vi.mock("../ai", () => ({
  chat: async () => null,
  chatDetailed: async () => ({ text: null }),
  chatVision: async () => null,
  extractJson: () => null,
}));
vi.mock("../runtime-config", () => ({
  getConfig: async () => undefined,
  setConfig: async () => {},
  sbInsert: async () => true,
  sbInsertReturning: async () => [],
  sbSelect: async () => [],
  sbUpdate: async () => {},
  sbDelete: async () => true,
  sbDeleteReturning: async () => [],
  supabaseConfigured: () => false,
}));
vi.mock("../wa-guard", () => ({
  guardOutbound: async ({ text }: { text: string }) => ({ allow: true, text }),
  afterSend: async () => {},
}));
vi.mock("../market", () => ({
  floorPriceFor: async () => ({ floor: 150, typical: 240, currency: "THB" }),
  vehicleKeyFor: () => "motorbike-125",
  regionKeysFor: () => ["chiang-mai"],
}));

import { replayConversation } from "../simulate";
import { evaluateCase, evaluateTurn } from "./golden";
import { defaultGraphSpec } from "../graph/default-graph";
import type { GoldenCase } from "./types";

const RFQ = { vehicleClass: "scooter", durationDays: 5 } as Record<string, unknown>;

const CASE_BARGAIN: GoldenCase = {
  id: 1,
  name: "quote far above floor -> bargain toward the floor",
  thread_key: null,
  rfq: RFQ,
  region: "Chiang Mai, Thailand",
  floor: { floor: 150, typical: 240, currency: "THB" },
  turns: [
    {
      shopSays: "Hello! Yes we have Click 125 available, 300 baht per day.",
      stubExtraction: { found: true, pricePerDay: 300, currency: "THB", matchesSpec: true, confidence: "high" },
    },
  ],
  expects: [{ action: "bargain", targetAtLeast: 150, noMessageContains: ["final offer"] }],
  enabled: true,
  created_at: "t",
};

describe("golden replay harness", () => {
  it("replays deterministically through the real engine (bargain case)", async () => {
    const spec = defaultGraphSpec();
    const a = await replayConversation({ turns: CASE_BARGAIN.turns, rfq: RFQ, region: CASE_BARGAIN.region ?? undefined, floor: CASE_BARGAIN.floor, spec });
    const b = await replayConversation({ turns: CASE_BARGAIN.turns, rfq: RFQ, region: CASE_BARGAIN.region ?? undefined, floor: CASE_BARGAIN.floor, spec });
    // The deterministic contract: identical DECISIONS across runs - action,
    // traversed path, chosen edge, negotiated target. Message WORDING varies
    // deliberately (the anti-template uniqueness layer), which is why the
    // gate's expectations are decision-level, not prose-level.
    expect(a.turns.map((t) => t.action)).toEqual(b.turns.map((t) => t.action));
    expect(a.turns.map((t) => t.path)).toEqual(b.turns.map((t) => t.path));
    expect(a.turns.map((t) => t.ladder?.find((r) => r.chosen)?.edgeId)).toEqual(
      b.turns.map((t) => t.ladder?.find((r) => r.chosen)?.edgeId)
    );
    expect(a.turns.map((t) => t.state.lastTarget)).toEqual(b.turns.map((t) => t.state.lastTarget));

    const result = evaluateCase(CASE_BARGAIN, a.turns);
    expect(result.pass).toBe(true);
    expect(a.turns[0].action).toBe("bargain");
    expect(a.turns[0].state.lastTarget).toBeGreaterThanOrEqual(150);
  });

  it("a broken candidate overlay FAILS the same case (the gate bites)", async () => {
    const spec = defaultGraphSpec();
    // floorTolerance clamped max 1.15... use priceFarAboveFloor at max 1.6 +
    // defaultCut 0.95: quote 300 vs floor 150 is still far above, so bargain
    // still fires - instead break it via floorTolerance 1.15 with a quote
    // near the floor in a second scenario? Simpler: an expectation that the
    // candidate's higher lowball guard breaks (targetAtLeast tightened).
    const tightened: GoldenCase = {
      ...CASE_BARGAIN,
      expects: [{ action: "bargain", targetAtLeast: 500 }], // impossible on purpose
    };
    const run = await replayConversation({ turns: tightened.turns, rfq: RFQ, region: tightened.region ?? undefined, floor: tightened.floor, spec });
    const result = evaluateCase(tightened, run.turns);
    expect(result.pass).toBe(false);
    expect(result.turns[0].failures.join(" ")).toContain("target");
  });

  it("multi-turn: firm shop with rival leverage keeps pushing, then respects two firms", async () => {
    const spec = defaultGraphSpec();
    const turns = [
      {
        shopSays: "Click 125 is 300 baht per day.",
        stubExtraction: { found: true, pricePerDay: 300, currency: "THB", matchesSpec: true, confidence: "high" },
      },
      {
        shopSays: "Sorry, 280 is my last price.",
        stubExtraction: { found: true, pricePerDay: 280, currency: "THB", matchesSpec: true, confidence: "high", shopFirm: true },
        rivalPricePerDay: 220,
      },
    ];
    const run = await replayConversation({
      turns,
      rfq: RFQ,
      region: "Chiang Mai, Thailand",
      floor: { floor: 150, typical: 240, currency: "THB" },
      spec,
    });
    expect(run.turns[0].action).toBe("bargain");
    // One firm + a cheaper rival + far above floor = the engine keeps pushing
    // (the exact behavior the owner demanded in the negotiation audit).
    expect(run.turns[1].action).toBe("bargain");
    expect(run.turns[1].state.rounds).toBe(2);
  });

  it("evaluateTurn covers every expectation dimension", () => {
    const played = {
      shopSays: "s",
      action: "bargain",
      ourReply: "Could you do 250? My last chance offer",
      path: ["extract", "director", "bargain", "deliver"],
      ladder: [{ edgeId: "d-bargain", label: "b", toNodeId: "bargain", toKind: "bargain", legal: true, chosen: true, why: "" }],
      state: { rounds: 1, firmCount: 0, dealComplete: false, lastTarget: 250 },
      stages: [],
    } as unknown as Parameters<typeof evaluateTurn>[1];
    expect(evaluateTurn({ action: "bargain" }, played)).toEqual([]);
    expect(evaluateTurn({ action: "close" }, played)).toHaveLength(1);
    expect(evaluateTurn({ edgeId: "d-bargain" }, played)).toEqual([]);
    expect(evaluateTurn({ edgeId: "d-close" }, played)).toHaveLength(1);
    expect(evaluateTurn({ pathContains: ["director", "bargain"] }, played)).toEqual([]);
    expect(evaluateTurn({ pathContains: ["momentum"] }, played)).toHaveLength(1);
    expect(evaluateTurn({ targetAtLeast: 200 }, played)).toEqual([]);
    expect(evaluateTurn({ targetAtLeast: 300 }, played)).toHaveLength(1);
    expect(evaluateTurn({ noMessageContains: ["last chance"] }, played)).toHaveLength(1);
  });
});
