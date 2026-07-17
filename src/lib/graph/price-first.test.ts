import { describe, it, expect, vi } from "vitest";

// The price-first gate (revision 4): while a strong-leverage bargain is
// ACTUALLY legal, probes/present/momentum are illegal - so the LLM director
// can no longer skip the price push (the Playground bug: rival 220, quote
// 250, and the agent's first move was a deposit probe).

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
  sbSelect: async () => [],
  sbUpdate: async () => {},
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

import { applyStrongBargainFact, leverageLost } from "./engine";
import {
  defaultGraphSpec,
  sanitizeGraphSpec,
  PRICE_FIRST_EDGE_IDS,
  DEFAULT_GRAPH_REVISION,
} from "./default-graph";
import { evalGraphCondition, factsFromLegacy } from "./conditions";
import type { GraphFacts, GraphSpec } from "./types";

/** The defect-B fact pattern: quote 250, rival 220, floor 150, all fields known. */
function leverageFacts(over: Partial<GraphFacts> = {}): GraphFacts {
  return factsFromLegacy(
    {
      sessionClosed: false,
      shopAskedQuestion: false,
      shopSentVehiclePhoto: false,
      hasUsablePrice: true,
      verified: true,
      hasClarifyMessage: false,
      matchesSpecNotFalse: true,
      priceAtOrBelowFloor: false,
      targetIsRealSaving: true,
      rivalCheaper: true,
      counts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
    },
    {
      priceFarAboveFloor: true,
      depositKnown: true,
      fulfillmentKnown: true,
      depositPassportOnly: true,
      dealComplete: true,
      rounds: 0,
      maxRounds: 4,
      firmCount: 0,
      ...over,
    }
  );
}

describe("strongBargainAvailable derived fact", () => {
  it("is TRUE when leverage exists and d-bargain is legal (defect-B pattern)", () => {
    const facts = applyStrongBargainFact(defaultGraphSpec(), leverageFacts());
    expect(facts.strongBargainAvailable).toBe(true);
  });

  it("is FALSE when leverage exists but NO bargain edge is legal (sheet-anchor cell)", () => {
    // rival=false, farAbove=true, targetSaving=false -> d-bargain's
    // anyG(saving, rival) fails -> the gate must NOT activate (this exact
    // cell deadlocked the naive condition-tree design).
    const facts = applyStrongBargainFact(
      defaultGraphSpec(),
      leverageFacts({ rivalCheaper: false, targetIsRealSaving: false } as Partial<GraphFacts>)
    );
    expect(facts.strongBargainAvailable).toBe(false);
  });

  it("is FALSE without leverage, after two firms, and when rounds are exhausted", () => {
    const spec = defaultGraphSpec();
    expect(
      applyStrongBargainFact(spec, leverageFacts({ rivalCheaper: false, priceFarAboveFloor: false }))
        .strongBargainAvailable
    ).toBe(false);
    expect(
      applyStrongBargainFact(spec, leverageFacts({ firmCount: 2 })).strongBargainAvailable
    ).toBe(false);
    expect(
      applyStrongBargainFact(spec, leverageFacts({ rounds: 4 })).strongBargainAvailable
    ).toBe(false);
  });
});

describe("price-first legality matrix", () => {
  it("gate ON: the five competing edges are illegal, d-bargain is legal", () => {
    const spec = defaultGraphSpec();
    const facts = applyStrongBargainFact(spec, leverageFacts());
    expect(facts.strongBargainAvailable).toBe(true);
    const byId = new Map(spec.edges.map((e) => [e.id, e]));
    expect(evalGraphCondition(byId.get("d-bargain")!.when, facts)).toBe(true);
    for (const id of PRICE_FIRST_EDGE_IDS) {
      expect(evalGraphCondition(byId.get(id)!.when, facts), id).toBe(false);
    }
  });

  it("gate OFF: probes/present behave exactly as before (no-leverage facts)", () => {
    const spec = defaultGraphSpec();
    const facts = applyStrongBargainFact(
      spec,
      leverageFacts({
        rivalCheaper: false,
        priceFarAboveFloor: false,
        targetIsRealSaving: false,
        depositKnown: false,
        fulfillmentKnown: false,
        dealComplete: false,
      } as Partial<GraphFacts>)
    );
    expect(facts.strongBargainAvailable).toBe(false);
    const byId = new Map(spec.edges.map((e) => [e.id, e]));
    expect(evalGraphCondition(byId.get("d-deposit-probe")!.when, facts)).toBe(true);
    expect(evalGraphCondition(byId.get("d-momentum")!.when, facts)).toBe(true);
  });
});

describe("revision-4 migration in sanitizeGraphSpec", () => {
  it("upgrades untouched pre-gate edges, stamps the revision, is idempotent", () => {
    // Simulate a production-saved spec from BEFORE the gate: strip the gate
    // conjunct + drop the revision stamp.
    const old = defaultGraphSpec() as GraphSpec & { revision?: number };
    for (const e of old.edges) {
      if ((PRICE_FIRST_EDGE_IDS as readonly string[]).includes(e.id) && (e.when as { kind?: string }).kind === "allG") {
        (e.when as { of: unknown[] }).of = (e.when as { of: { kind?: string; of?: { kind?: string } }[] }).of.filter(
          (c) => !(c.kind === "notG" && c.of?.kind === "strongBargainAvailable")
        );
      }
    }
    delete old.revision;

    const migrated = sanitizeGraphSpec(old);
    expect(migrated.revision).toBe(DEFAULT_GRAPH_REVISION);
    for (const id of PRICE_FIRST_EDGE_IDS) {
      const when = migrated.edges.find((e) => e.id === id)!.when as { of: { kind?: string; of?: { kind?: string } }[] };
      expect(
        when.of.some((c) => c.kind === "notG" && c.of?.kind === "strongBargainAvailable"),
        id
      ).toBe(true);
    }
    // Idempotent: sanitizing again changes nothing.
    expect(JSON.stringify(sanitizeGraphSpec(migrated))).toBe(JSON.stringify(migrated));
  });

  it("NEVER overwrites an owner-customized condition", () => {
    const old = defaultGraphSpec() as GraphSpec & { revision?: number };
    const probe = old.edges.find((e) => e.id === "d-deposit-probe")!;
    probe.when = { kind: "always" } as never; // the owner's own rule
    delete old.revision;
    const migrated = sanitizeGraphSpec(old);
    expect((migrated.edges.find((e) => e.id === "d-deposit-probe")!.when as { kind: string }).kind).toBe(
      "always"
    );
  });
});

describe("leverage guard (validator revisions must keep the levers)", () => {
  const original =
    "Oh sorry, I already got a quote for 220 a day for the same scooter. I'd love to book with you if you can do 200 a day for 3 days? Thanks!";

  it("flags the exact production incident (rival + days dropped)", () => {
    const lost = leverageLost(original, "Can you do 200 per day for 3 days?", {
      rivalPrice: 220,
      target: 200,
      durationDays: 3,
    });
    expect(lost.join(" ")).toContain("220");
    expect(lost.join(" ")).not.toContain("200"); // target survived
  });

  it("passes a faithful revision and ignores levers the original never had", () => {
    expect(
      leverageLost(original, "I got 220/day elsewhere - could you do 200 for the 3 days?", {
        rivalPrice: 220,
        target: 200,
        durationDays: 3,
      })
    ).toEqual([]);
    expect(leverageLost("Can you do 200?", "Could you manage 200?", { rivalPrice: 220, target: 200 })).toEqual(
      []
    );
  });

  it("tolerates thousands separators and never matches inside longer numbers", () => {
    expect(leverageLost("How about 50,000 IDR?", "Deal at fifty thousand?", { target: 50000 })).toHaveLength(1);
    expect(leverageLost("1220 total", "still 1220 total", { rivalPrice: 220 })).toEqual([]);
  });
});
