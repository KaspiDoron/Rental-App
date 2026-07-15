import { describe, it, expect } from "vitest";
import { evalGraphCondition, factsFromLegacy } from "./conditions";
import type { GraphCondition } from "./types";

const base = factsFromLegacy({
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
});

describe("evalGraphCondition - legacy kinds still work", () => {
  it("always", () => {
    expect(evalGraphCondition({ kind: "always" }, base)).toBe(true);
  });
  it("hasUsablePrice value match", () => {
    expect(evalGraphCondition({ kind: "hasUsablePrice", value: false }, base)).toBe(true);
    expect(
      evalGraphCondition({ kind: "hasUsablePrice", value: true }, { ...base, hasUsablePrice: true })
    ).toBe(true);
  });
  it("counterBelow / counterAtLeast", () => {
    const f = { ...base, counts: { clarify: 1, bargain: 2, answer: 0, close: 0 } };
    expect(evalGraphCondition({ kind: "counterBelow", counter: "bargain", max: 1 }, f)).toBe(false);
    expect(evalGraphCondition({ kind: "counterAtLeast", counter: "bargain", min: 2 }, f)).toBe(true);
  });
});

describe("evalGraphCondition - graph kinds", () => {
  it("fieldKnown", () => {
    expect(
      evalGraphCondition({ kind: "fieldKnown", field: "deposit", value: true }, { ...base, depositKnown: true })
    ).toBe(true);
    expect(
      evalGraphCondition({ kind: "fieldKnown", field: "fulfillment", value: false }, base)
    ).toBe(true);
  });
  it("roundsBelow defaults to maxRounds", () => {
    expect(evalGraphCondition({ kind: "roundsBelow" }, { ...base, rounds: 2, maxRounds: 3 })).toBe(true);
    expect(evalGraphCondition({ kind: "roundsBelow" }, { ...base, rounds: 3, maxRounds: 3 })).toBe(false);
    expect(evalGraphCondition({ kind: "roundsBelow", max: 1 }, { ...base, rounds: 1 })).toBe(false);
  });
  it("firmCountAtLeast + toneDegraded", () => {
    expect(evalGraphCondition({ kind: "firmCountAtLeast", min: 2 }, { ...base, firmCount: 2 })).toBe(true);
    expect(evalGraphCondition({ kind: "toneDegraded" }, { ...base, toneDegraded: true })).toBe(true);
  });
  it("depositPassportOnly + cashAlternativeAskedAlready", () => {
    expect(evalGraphCondition({ kind: "depositPassportOnly" }, { ...base, depositPassportOnly: true })).toBe(true);
    expect(
      evalGraphCondition({ kind: "cashAlternativeAskedAlready" }, { ...base, cashAlternativeAsked: true })
    ).toBe(true);
  });
  it("hasMedia + mediaCoherent", () => {
    expect(evalGraphCondition({ kind: "hasMedia", media: "audio" }, { ...base, hasAudio: true })).toBe(true);
    expect(evalGraphCondition({ kind: "hasMedia", media: "any" }, { ...base, hasImage: true })).toBe(true);
    expect(evalGraphCondition({ kind: "mediaCoherent", value: false }, { ...base, mediaCoherent: false })).toBe(true);
  });
  it("eventIs + nodeRanBelow + pickup", () => {
    expect(evalGraphCondition({ kind: "eventIs", event: "tick" }, { ...base, event: "tick" })).toBe(true);
    expect(evalGraphCondition({ kind: "nodeRanBelow", nodeId: "bargain", max: 2 }, { ...base, nodeRuns: { bargain: 1 } })).toBe(true);
    expect(evalGraphCondition({ kind: "nodeRanBelow", nodeId: "bargain", max: 2 }, { ...base, nodeRuns: { bargain: 2 } })).toBe(false);
    expect(evalGraphCondition({ kind: "pickupOffered" }, { ...base, pickupOffered: true })).toBe(true);
  });
});

describe("evalGraphCondition - mixed composites", () => {
  it("allG mixing legacy + graph kinds", () => {
    const cond: GraphCondition = {
      kind: "allG",
      of: [
        { kind: "hasUsablePrice", value: true },
        { kind: "fieldKnown", field: "deposit", value: false },
      ],
    };
    expect(evalGraphCondition(cond, { ...base, hasUsablePrice: true, depositKnown: false })).toBe(true);
    expect(evalGraphCondition(cond, { ...base, hasUsablePrice: true, depositKnown: true })).toBe(false);
  });
  it("notG wrapping a graph kind", () => {
    expect(evalGraphCondition({ kind: "notG", of: { kind: "toneDegraded" } }, base)).toBe(true);
  });
  it("legacy all/any trees containing graph kinds evaluate correctly", () => {
    const cond = {
      kind: "all",
      of: [{ kind: "sessionClosed" }, { kind: "pickupOffered" }],
    } as unknown as GraphCondition;
    expect(evalGraphCondition(cond, { ...base, sessionClosed: true, pickupOffered: true })).toBe(true);
    expect(evalGraphCondition(cond, { ...base, sessionClosed: true, pickupOffered: false })).toBe(false);
  });
  it("an unknown kind never matches and never throws", () => {
    expect(evalGraphCondition({ kind: "nope" } as unknown as GraphCondition, base)).toBe(false);
  });
});
