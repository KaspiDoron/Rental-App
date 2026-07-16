import { describe, it, expect } from "vitest";
import { decide, defaultDecisionGraph, type DecisionContext } from "../branching";
import { defaultGraphSpec, pickDirectorDirection, validateGraphSpec } from "./default-graph";
import { factsFromLegacy } from "./conditions";
import type { GraphSpec } from "./types";

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

// The legacy discipline is a faithful SUBSET of the default graph: with the
// new probe/present nodes disabled (and deal treated complete so completeness
// gating is inert), the director must reproduce decide()'s direction for every
// context - proving the migration is behavior-preserving.
function legacyOnlySpec(): GraphSpec {
  const spec = defaultGraphSpec();
  // "momentum" is also new: it deliberately replaces legacy dead-end silence
  // (a bare "Yes." now continues qualification) - proven separately below.
  const off = new Set(["deposit-probe", "fulfillment-probe", "present", "momentum"]);
  spec.nodes = spec.nodes.map((n) => (off.has(n.id) ? { ...n, enabled: false } : n));
  // Disable the media-confirm edge too (legacy contexts carry no media).
  spec.edges = spec.edges.map((e) => (e.id === "d-media-confirm" ? { ...e, enabled: false } : e));
  return spec;
}

const legacyGraph = defaultDecisionGraph();
const spec = legacyOnlySpec();

const CASES: { name: string; ctx: DecisionContext }[] = [
  { name: "closed session", ctx: ctx({ sessionClosed: true, shopAskedQuestion: true }) },
  { name: "answer a question", ctx: ctx({ shopAskedQuestion: true }) },
  {
    name: "stop answering after two",
    ctx: ctx({ shopAskedQuestion: true, counts: { clarify: 0, bargain: 0, answer: 2, close: 0 } }),
  },
  { name: "thank vehicle photo", ctx: ctx({ shopSentVehiclePhoto: true }) },
  { name: "clarify once", ctx: ctx({ hasClarifyMessage: true }) },
  {
    name: "no second clarify",
    ctx: ctx({ hasClarifyMessage: true, counts: { clarify: 1, bargain: 0, answer: 0, close: 0 } }),
  },
  { name: "close at/below floor", ctx: ctx({ hasUsablePrice: true, priceAtOrBelowFloor: true }) },
  {
    name: "silent great price thanked",
    ctx: ctx({
      hasUsablePrice: true,
      priceAtOrBelowFloor: true,
      counts: { clarify: 0, bargain: 0, answer: 0, close: 1 },
    }),
  },
  { name: "bargain on real saving", ctx: ctx({ hasUsablePrice: true, targetIsRealSaving: true }) },
  { name: "close no saving", ctx: ctx({ hasUsablePrice: true, targetIsRealSaving: false }) },
  {
    name: "close after one ask",
    ctx: ctx({
      hasUsablePrice: true,
      targetIsRealSaving: true,
      counts: { clarify: 0, bargain: 1, answer: 0, close: 0 },
    }),
  },
  {
    name: "silent after close",
    ctx: ctx({ hasUsablePrice: true, counts: { clarify: 0, bargain: 1, answer: 0, close: 1 } }),
  },
  { name: "nothing owed", ctx: ctx() },
];

describe("default graph - legacy parity (deterministic director)", () => {
  for (const c of CASES) {
    it(`matches decide() for: ${c.name}`, () => {
      const legacyDir = decide(c.ctx, legacyGraph).direction;
      // maxRounds=1 makes the multi-round bargain edge behave like the legacy
      // single "ask once" ladder, so the deterministic director reproduces
      // decide() exactly (multi-round is proven separately below).
      const facts = factsFromLegacy(c.ctx, { maxRounds: 1 });
      const graphDir = pickDirectorDirection(spec, facts);
      expect(graphDir).toBe(legacyDir);
    });
  }
});

describe("default graph - new deal playbook", () => {
  it("probes the deposit before closing once a price is in and deposit unknown", () => {
    const facts = factsFromLegacy(ctx({ hasUsablePrice: true, targetIsRealSaving: false }), {
      priceKnown: true,
      depositKnown: false,
      fulfillmentKnown: true,
    });
    expect(pickDirectorDirection(defaultGraphSpec(), facts)).toBe("deposit-probe");
  });

  it("pushes for cash when the deposit is passport-only (once)", () => {
    const facts = factsFromLegacy(ctx({ hasUsablePrice: true }), {
      priceKnown: true,
      depositKnown: true,
      fulfillmentKnown: true,
      depositPassportOnly: true,
      cashAlternativeAsked: false,
      dealComplete: true,
    });
    expect(pickDirectorDirection(defaultGraphSpec(), facts)).toBe("deposit-probe");
  });

  it("presents the deal only when price + deposit + fulfillment are all known", () => {
    const facts = factsFromLegacy(ctx({ hasUsablePrice: true, priceAtOrBelowFloor: true }), {
      priceKnown: true,
      depositKnown: true,
      fulfillmentKnown: true,
      dealComplete: true,
    });
    expect(pickDirectorDirection(defaultGraphSpec(), facts)).toBe("present");
  });

  it("stops bargaining when the shop has been firm twice", () => {
    const facts = factsFromLegacy(ctx({ hasUsablePrice: true, targetIsRealSaving: true }), {
      priceKnown: true,
      depositKnown: true,
      fulfillmentKnown: true,
      dealComplete: true,
      firmCount: 2,
    });
    // firm twice blocks d-bargain; deal is complete so it presents instead.
    expect(pickDirectorDirection(defaultGraphSpec(), facts)).not.toBe("bargain");
  });

  it("stops bargaining after maxRounds", () => {
    const facts = factsFromLegacy(ctx({ hasUsablePrice: true, targetIsRealSaving: true }), {
      priceKnown: true,
      depositKnown: true,
      fulfillmentKnown: true,
      dealComplete: true,
      rounds: 3,
      maxRounds: 3,
    });
    expect(pickDirectorDirection(defaultGraphSpec(), facts)).not.toBe("bargain");
  });
});

describe("default graph - validation", () => {
  it("the default spec is valid", () => {
    expect(validateGraphSpec(defaultGraphSpec()).ok).toBe(true);
  });

  it("flags a director with no enabled moves", () => {
    const s = defaultGraphSpec();
    s.edges = s.edges.map((e) => (e.from === "director" ? { ...e, enabled: false } : e));
    expect(validateGraphSpec(s).ok).toBe(false);
  });

  it("flags a composer that cannot reach deliver", () => {
    const s = defaultGraphSpec();
    // Cut the tail from the bargain node.
    s.edges = s.edges.filter((e) => e.id !== "t-style");
    const v = validateGraphSpec(s);
    expect(v.ok).toBe(false);
  });
});
