import { describe, it, expect } from "vitest";
import { decide, defaultDecisionGraph, type DecisionContext } from "./branching";

const graph = defaultDecisionGraph();

function ctx(over: Partial<DecisionContext> = {}): DecisionContext {
  return {
    sessionClosed: false,
    shopAskedQuestion: false,
    shopSentVehiclePhoto: false,
    hasUsablePrice: false,
    verified: false,
    hasClarifyMessage: false,
    matchesSpecNotFalse: true,
    priceAtOrBelowFloor: false,
    targetIsRealSaving: false,
    rivalCheaper: false,
    counts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
    ...over,
  };
}

describe("decide (default graph)", () => {
  it("a closed session stays silent no matter what", () => {
    expect(decide(ctx({ sessionClosed: true, shopAskedQuestion: true }), graph).direction).toBe(
      "silent"
    );
  });

  it("answers a question from the shop", () => {
    expect(decide(ctx({ shopAskedQuestion: true }), graph).direction).toBe("answer");
  });

  it("stops answering after two answers", () => {
    const d = decide(ctx({ shopAskedQuestion: true, counts: { clarify: 0, bargain: 0, answer: 2, close: 0 } }), graph);
    expect(d.direction).toBe("silent");
  });

  it("thanks the shop for a vehicle photo when there is no price", () => {
    expect(decide(ctx({ shopSentVehiclePhoto: true }), graph).direction).toBe("answer");
  });

  it("clarifies once when no price yet", () => {
    expect(decide(ctx({ hasClarifyMessage: true }), graph).direction).toBe("clarify");
  });

  it("does not clarify a second time", () => {
    const d = decide(ctx({ hasClarifyMessage: true, counts: { clarify: 1, bargain: 0, answer: 0, close: 0 } }), graph);
    expect(d.direction).toBe("silent");
  });

  it("closes warmly on an at/below-floor price", () => {
    expect(
      decide(ctx({ hasUsablePrice: true, priceAtOrBelowFloor: true }), graph).direction
    ).toBe("close");
  });

  it("stays silent on a great price once already thanked", () => {
    const d = decide(
      ctx({
        hasUsablePrice: true,
        priceAtOrBelowFloor: true,
        counts: { clarify: 0, bargain: 0, answer: 0, close: 1 },
      }),
      graph
    );
    expect(d.direction).toBe("silent");
  });

  it("bargains once toward the floor on a real saving", () => {
    expect(
      decide(ctx({ hasUsablePrice: true, targetIsRealSaving: true }), graph).direction
    ).toBe("bargain");
  });

  it("closes when no genuine saving is possible", () => {
    expect(
      decide(ctx({ hasUsablePrice: true, targetIsRealSaving: false }), graph).direction
    ).toBe("close");
  });

  it("thanks once after our single ask, never pushing twice", () => {
    const afterAsk = ctx({
      hasUsablePrice: true,
      targetIsRealSaving: true,
      counts: { clarify: 0, bargain: 1, answer: 0, close: 0 },
    });
    expect(decide(afterAsk, graph).direction).toBe("close");
    const afterClose = ctx({
      hasUsablePrice: true,
      counts: { clarify: 0, bargain: 1, answer: 0, close: 1 },
    });
    expect(decide(afterClose, graph).direction).toBe("silent");
  });

  it("defaults to silence when nothing is owed", () => {
    expect(decide(ctx(), graph).direction).toBe("silent");
  });

  it("an empty graph is safe (silent)", () => {
    expect(decide(ctx({ shopAskedQuestion: true }), { version: 1, rules: [] }).direction).toBe(
      "silent"
    );
  });
});
