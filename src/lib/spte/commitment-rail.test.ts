import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { runPostRails } from "./rails";
import type { MoveKind, TurnArtifact, TurnContext } from "./types";

// A COMMITMENT IS THE TRAVELLER'S TO MAKE, AND THEY MAKE IT WITH ONE BUTTON.
//
// The farewell rail refused agreement language on three moves. Every other move
// could say "we'll take it" and send it - from the traveller's own number, to a
// shop that then holds a bike for someone who has not decided. The owner's
// ruling: probes stay (asking what deposit they take is how you learn), but
// commitment is railed on EVERY move until Lock This Deal is tapped.

const ctx = (): TurnContext =>
  ({
    legalMoves: [],
    tail: [],
    guards: { floorPerDay: 100 },
    inbound: {
      verified: {
        vehicleStatus: "match",
        vehicleAsked: true,
        vehicleQuestion: null,
        pricePerDay: 180,
        sheetPricePerDay: null,
      },
    },
    thread: { digest: { facts: [], round: 1, quotedPricePerDay: 180, options: [] } },
    session: {
      rivals: [],
      currency: "THB",
      rfq: { durationDays: 3, engineSizeCc: 125, vehicleClass: "scooter" },
    },
  }) as unknown as TurnContext;

const draft = (move: MoveKind, message: string): TurnArtifact =>
  ({ move, message, leverageUsed: [], digestPatch: [], read: { intent: "" }, think: "" }) as TurnArtifact;

const run = (move: MoveKind, message: string) => runPostRails(ctx(), draft(move, message));

describe("REPRODUCTION: the moves the old rail never covered", () => {
  const cases: [MoveKind, string][] = [
    ["bargain", "150 works for me, we'll take it - can you hold it?"],
    ["present", "Great, I'll take it. Book it for me please."],
    ["momentum", "Still keen - please reserve it for me."],
    ["deposit-probe", "Sounds fine, I accept. What deposit do you need?"],
    ["fulfillment-probe", "Deal! I'm on my way to pick it up."],
    ["answer", "Yes - let's do it."],
  ];

  for (const [move, message] of cases) {
    it(`a ${move} may not commit`, () => {
      const r = run(move, message);
      expect(r.ok).toBe(false);
      expect(r.rejected?.rule).toBe("commitment");
    });
  }
});

describe("the one move that MAY commit is the one the traveller authorised", () => {
  it("closing-message is produced only after Lock This Deal, so it passes", () => {
    const r = run("closing-message", "Perfect - I'll take it, see you at the shop!");
    expect(r.ok).toBe(true);
    expect(r.finalText).toBeTruthy();
  });
});

describe("information gathering is untouched - the owner's ruling", () => {
  const fine: [MoveKind, string][] = [
    ["deposit-probe", "What deposit do you require for the 125?"],
    ["fulfillment-probe", "Do you deliver to the hotel, or is it pickup only?"],
    ["bargain", "Another shop quoted 150 - can you do the same for 3 days?"],
    ["present", "They're offering 180 a day including a helmet."],
    // Register, not a booking. Haggling is full of soft approval and railing it
    // would replace real drafts with templates for no safety gain.
    ["bargain", "150 sounds good - can you do it?"],
    ["answer", "Yes, an automatic is what I'm after."],
  ];

  for (const [move, message] of fine) {
    it(`${move}: "${message.slice(0, 34)}..." goes out`, () => {
      const r = run(move, message);
      expect(r.rejected?.rule).not.toBe("commitment");
    });
  }
});

describe("and the farewell rail still owns the softer words", () => {
  it("a goodbye may not even say 'good price'", () => {
    const r = run("farewell", "Thanks anyway - 180 a day is a good price!");
    expect(r.ok).toBe(false);
    expect(r.rejected?.rule).toBe("farewell-integrity");
  });
});
