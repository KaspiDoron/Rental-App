import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { legalMovesFor } from "./spte/policy";
import { runPostRails } from "./spte/rails";
import type { TurnContext, TurnArtifact, VerifiedExtraction } from "./spte/types";
import { emptyDigest } from "./spte/digest";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE OWNER'S SLIDERS MOVED THE ENGINE THAT DOES NOT RUN.
//
// CLAUDE.md says thresholds "live in the clamped policy_overlay", and
// engine-route makes SPTE the engine with the graph as failover only. Nothing
// under src/lib/spte imported the overlay. Three concrete divergences:
//
//   - priceFarAboveFloor was the literal 1.25 in spte/policy, while the
//     overlay's default is 1.08 and its own comment calls 1.25 "far too soft".
//     So the documented tightening applied only to the fallback engine.
//   - maxRounds was the literal 6 in spte/live, while the graph spec's
//     owner-editable maxRoundsPerShop defaults to 4. The live engine allowed
//     50% more pushes per shop than the configured policy.
//   - bannedPhrases was scrubbed only in graph/engine.ts:1072, so a phrase the
//     owner outlawed still went out on every real message.
//
// Every Ops slider that was not one of these still needs checking; these are
// the three the audit could point at a concrete divergence for.

/**
 * The same fixture shape spte.test.ts uses, so these tests exercise the real
 * policy/rails code rather than a hand-rolled stand-in.
 */
function ctx(partial: Partial<TurnContext> & { verified: VerifiedExtraction }): TurnContext {
  return {
    session: {
      sessionId: "s1",
      rfq: {
        vehicleClass: "scooter",
        engineSizeCc: 125,
        transmission: "any",
        durationDays: 4,
        accessories: [],
        fulfillment: "any",
        vendorMessage: "",
      },
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
    inbound: { text: partial.inbound?.text ?? "", verified: partial.verified },
    legalMoves: [],
    guards: { maxRounds: 4, ...(partial.guards ?? {}) },
    event: "shop-message",
  } as TurnContext;
}

/** One firm refusal, so bargaining hinges ENTIRELY on the price-far-above-floor
 *  test - the branch the owner's threshold governs. */
function ctxAtFirm(quote: number, floor: number, guards: Partial<TurnContext["guards"]> = {}) {
  return ctx({
    thread: { digest: { ...emptyDigest(), firmCount: 1, round: 0 } } as TurnContext["thread"],
    verified: { found: true, pricePerDay: quote, currency: "PHP" },
    guards: { floorPerDay: floor, maxRounds: 4, ...guards },
    inbound: { text: "last price", verified: {} as VerifiedExtraction },
  });
}

describe("priceFarAboveFloor is the owner's number, not a literal", () => {
  it("REPRODUCTION: at 1.25 a quote 15% above the floor retires bargaining", () => {
    // The old hard-coded behaviour: 115 vs a 100 floor is not "far above" at
    // 1.25, so after one firm refusal the engine gave up on the price.
    const legal = legalMovesFor(ctxAtFirm(115, 100, { priceFarAboveFloor: 1.25 }));
    expect(legal).not.toContain("bargain");
  });

  it("...and at the overlay's own default of 1.08 it keeps pushing", () => {
    const legal = legalMovesFor(ctxAtFirm(115, 100, { priceFarAboveFloor: 1.08 }));
    expect(legal).toContain("bargain");
  });

  it("an absent threshold falls back to the historical 1.25, never to nothing", () => {
    // A config outage must keep TODAY's behaviour rather than silently adopting
    // a different policy - which is why the field is optional with a literal
    // default rather than required.
    const legal = legalMovesFor(ctxAtFirm(115, 100));
    expect(legal).not.toContain("bargain");
    expect(readCode("src/lib/spte/policy.ts")).toMatch(
      /ctx\.guards\.priceFarAboveFloor \?\? 1\.25/
    );
  });

  it("and the overlay really does default to 1.08 - the divergence was real", () => {
    const overlay = readCode("src/lib/ops/overlay.ts");
    expect(overlay).toMatch(/priceFarAboveFloor: 1\.08,/);
  });
});

describe("the round cap is the spec's, not a literal 6", () => {
  it("REGRESSION: live.ts reads maxRoundsPerShop", () => {
    const live = readCode("src/lib/spte/live.ts");
    expect(live).not.toMatch(/maxRounds: 6/);
    expect(live).toMatch(/maxRounds: policy\.maxRounds,/);
    expect(live).toMatch(/spec\.settings\.maxRoundsPerShop/);
  });

  it("the outage fallback is the SPEC's default, not the old literal", () => {
    const live = readCode("src/lib/spte/live.ts");
    expect(live).toMatch(/const DEFAULT_MAX_ROUNDS = 4;/);
    expect(readCode("src/lib/graph/default-graph.ts")).toMatch(/maxRoundsPerShop: 4,/);
  });

  it("replay still pins its own overlay, so the golden suite stays bit-stable", () => {
    // Same contract the graph engine uses at engine.ts:384. Without it, editing
    // the live overlay would change every golden expectation.
    const live = readCode("src/lib/spte/live.ts");
    expect(live).toMatch(/input\.overlay \?\?\s*\(await getPolicyOverlay\(\)/);
  });
});

describe("a banned phrase cannot leave the primary engine", () => {
  const artifact = { move: "answer", message: "Sure thing! We can do 250 a day." } as TurnArtifact;

  function railCtx(bannedPhrases: string[]) {
    return ctx({
      verified: { found: true, pricePerDay: 250, currency: "PHP" },
      guards: { maxRounds: 4, bannedPhrases },
      inbound: { text: "250 a day", verified: {} as VerifiedExtraction },
    });
  }

  it("REPRODUCTION: with no ban the phrase goes out", () => {
    const r = runPostRails(railCtx([]), artifact);
    expect(r.ok).toBe(true);
    expect(r.finalText).toMatch(/Sure thing!/);
  });

  it("banned, it is scrubbed - the graph engine has done this since the overlay shipped", () => {
    const r = runPostRails(railCtx(["Sure thing!"]), artifact);
    expect(r.ok).toBe(true);
    expect(r.finalText).not.toMatch(/Sure thing/);
    expect(r.finalText).toMatch(/250 a day/);
  });

  it("matching is case-insensitive and literal, not a regex the owner typed", () => {
    // An owner typing "we can do" must not be able to write a pattern; the
    // metacharacters are escaped exactly as the graph engine escapes them.
    const r = runPostRails(railCtx(["SURE THING!", "a.day"]), artifact);
    expect(r.finalText).not.toMatch(/Sure thing/i);
    // "a.day" is a literal, so "a day" survives - `.` is not a wildcard here.
    expect(r.finalText).toMatch(/a day/);
  });

  it("a scrub that empties the message drops the turn rather than sending a fragment", () => {
    const r = runPostRails(railCtx(["Sure thing! We can do 250 a day."]), artifact);
    expect(r.ok).toBe(false);
    expect(r.rejected?.rule).toBe("banned-phrase");
  });

  it("the rails stay pure - config is awaited in the context builder, not here", () => {
    const rails = readCode("src/lib/spte/rails.ts");
    expect(rails).toMatch(/ctx\.guards\.bannedPhrases \?\? \[\]/);
    expect(rails).not.toMatch(/await getPolicyOverlay/);
    expect(readCode("src/lib/spte/live.ts")).toMatch(
      /bannedPhrases: policy\.overlay\.bannedPhrases,/
    );
  });
});
