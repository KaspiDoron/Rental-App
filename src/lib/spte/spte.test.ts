import { describe, it, expect } from "vitest";
import { legalMovesFor, reflexTurn, coerceToLegal } from "./policy";
import { mergeDigest, emptyDigest } from "./digest";
import { runPostRails } from "./rails";
import type { TurnContext, TurnArtifact, VerifiedExtraction } from "./types";

function ctx(partial: Partial<TurnContext> & { verified: VerifiedExtraction }): TurnContext {
  return {
    session: {
      sessionId: "s1",
      rfq: { vehicleClass: "scooter", engineSizeCc: 125, transmission: "any", durationDays: 4, accessories: [], fulfillment: "any", vendorMessage: "" },
      currency: "PHP",
      benchmark: null,
      lowest: null,
      rivals: [],
      ...(partial.session ?? {}),
    },
    thread: {
      threadKey: "u:63",
      vendorId: "v1",
      shop: "Shop A",
      digest: emptyDigest(),
      ...(partial.thread ?? {}),
    },
    tail: [],
    inbound: { text: "", verified: partial.verified },
    legalMoves: [],
    guards: { maxRounds: 4, ...(partial.guards ?? {}) },
    event: "shop-message",
  };
}

describe("SPTE policy rails (legal move computation)", () => {
  it("a live price with rounds left makes bargain legal and FIRST (bargain-first)", () => {
    const c = ctx({ verified: { found: true, pricePerDay: 500, currency: "PHP", askedQuestion: false } });
    const legal = legalMovesFor(c);
    expect(legal[0]).toBe("bargain");
  });

  it("bargain-first: deposit/fulfillment probes are NOT legal while bargain is", () => {
    const c = ctx({ verified: { found: true, pricePerDay: 500 } });
    const legal = legalMovesFor(c);
    expect(legal).toContain("bargain");
    expect(legal).not.toContain("deposit-probe");
    expect(legal).not.toContain("fulfillment-probe");
  });

  it("a first-turn decline owes exactly one close then silence (B7 structural)", () => {
    const c = ctx({ verified: { found: false, declined: true } });
    const legal = legalMovesFor(c);
    expect(legal).toEqual(["close", "silent"]);
  });

  it("wrong vehicle -> redirect-close on first contact, never bare silence", () => {
    const c = ctx({ verified: { found: false, wrongVehicle: true } });
    const legal = legalMovesFor(c);
    expect(legal).toContain("redirect-close");
    expect(legal).not.toContain("silent");
  });

  it("a shop asking our delivery location makes pickup-location legal", () => {
    const c = ctx({ verified: { found: false, askedLocation: true } });
    expect(legalMovesFor(c)).toContain("pickup-location");
  });
});

describe("SPTE reflex tier (0-token)", () => {
  it("a lone silent legal move resolves reflexively, no LLM", () => {
    // A declined thread that already sent its goodbye owes only silence.
    const c = ctx({ verified: { found: false, declined: true } });
    c.thread.digest = { ...emptyDigest(), facts: ["closed - one goodbye sent"] };
    c.legalMoves = legalMovesFor(c); // -> ['silent']
    expect(c.legalMoves).toEqual(["silent"]);
    expect(reflexTurn(c)?.move).toBe("silent");
  });
  it("a composable move set does NOT reflex (needs the single pass)", () => {
    const c = ctx({ verified: { found: true, pricePerDay: 500 } });
    c.legalMoves = legalMovesFor(c);
    expect(reflexTurn(c)).toBeNull();
  });
});

describe("SPTE move coercion (the B7 lesson generalized)", () => {
  it("an out-of-set LLM move is coerced to the top legal move", () => {
    const artifact = { move: "present" } as TurnArtifact;
    expect(coerceToLegal(artifact, ["close", "silent"])).toBe("close");
  });
  it("a legal LLM move is kept", () => {
    const artifact = { move: "bargain" } as TurnArtifact;
    expect(coerceToLegal(artifact, ["bargain", "answer"])).toBe("bargain");
  });
});

describe("SPTE post-rails (deterministic number + protocol integrity)", () => {
  const base = ctx({ verified: { found: true, pricePerDay: 500, currency: "PHP" } });

  it("rejects a fabricated rival price (anti-hallucination)", () => {
    const a = { move: "bargain", message: "Another shop offered 200, can you match?", leverageUsed: [], digestPatch: [], read: { intent: "" }, think: "" } as TurnArtifact;
    const r = runPostRails({ ...base, session: { ...base.session, rivals: [] }, guards: { maxRounds: 4, floorPerDay: 300 } }, a);
    expect(r.ok).toBe(false);
    expect(r.rejected?.rule).toBe("fabricated-rival");
  });

  it("rejects an ask below the market floor", () => {
    const a = { move: "bargain", message: "Can you do 100 per day?", leverageUsed: [], digestPatch: [], read: { intent: "" }, think: "" } as TurnArtifact;
    const r = runPostRails({ ...base, guards: { maxRounds: 4, floorPerDay: 300 } }, a);
    expect(r.ok).toBe(false);
    expect(r.rejected?.rule).toBe("below-floor");
  });

  it("passes a clean bargain and never finalizes a time", () => {
    const a = { move: "bargain", message: "Thanks! Any chance you can do 400 for 4 days?", leverageUsed: [], digestPatch: [], read: { intent: "" }, think: "" } as TurnArtifact;
    const r = runPostRails({ ...base, guards: { maxRounds: 4, floorPerDay: 300 } }, a);
    expect(r.ok).toBe(true);
    expect(r.finalText).toContain("400");
  });

  it("strips a concrete time commitment and appends the defer line", () => {
    const a = { move: "close", message: "Great, see you tomorrow at 9am!", leverageUsed: [], digestPatch: [], read: { intent: "" }, think: "" } as TurnArtifact;
    const r = runPostRails(base, a);
    expect(r.ok).toBe(true);
    expect(r.finalText).toMatch(/confirm the exact time/i);
    expect(r.finalText).not.toMatch(/9am/);
  });
});

describe("SPTE digest merge (memory consolidation)", () => {
  it("banks a verified quote deterministically and bumps round on bargain", () => {
    const a = { move: "bargain", digestPatch: ["shop is friendly"], leverageUsed: [], read: { intent: "" }, think: "" } as TurnArtifact;
    const d = mergeDigest(emptyDigest(), a, { found: true, pricePerDay: 450, currency: "PHP" });
    expect(d.quotedPricePerDay).toBe(450);
    expect(d.round).toBe(1);
    expect(d.facts.some((f) => /450/.test(f))).toBe(true);
    expect(d.facts).toContain("shop is friendly");
  });
  it("caps durable facts and evicts oldest", () => {
    let d = emptyDigest();
    const a = (f: string) => ({ move: "answer", digestPatch: [f], leverageUsed: [], read: { intent: "" }, think: "" }) as TurnArtifact;
    for (let i = 0; i < 15; i++) d = mergeDigest(d, a(`fact ${i}`), { found: false });
    expect(d.facts.length).toBeLessThanOrEqual(10);
    expect(d.facts).not.toContain("fact 0");
    expect(d.facts).toContain("fact 14");
  });
});
