import { describe, it, expect } from "vitest";
import { legalMovesFor, atSessionLow } from "./policy";
import { planLeverage, leadCard } from "../negotiation/leverage";
import { emptyDigest } from "./digest";
import type { TurnContext, VerifiedExtraction, ThreadDigest } from "./types";

// KO TAO, 12:39.
//
//   12:22  LLL Koh Tao quotes 180/day  <- the cheapest price of the whole hunt
//   12:23  Sky Light quotes 250/day
//   12:39  us, to LLL: "That's a bit high for me..."
//
// We argued with the cheapest shop on the island, against a floor we had set
// ourselves, while a shop 70 baht more expensive sat in the same session. The
// engine had the number - `session.lowest` has been computed since SPTE
// shipped - and nothing that decides anything ever read it: a swarm signal and
// a telemetry chip. `legalMovesFor` never saw it, and `policy.ts` did not
// contain the word.
//
// The owner's rule, and it is the right one: exactly ONE price move at or
// below the session low, then terms, whatever happens.

const digest = (over: Partial<ThreadDigest> = {}): ThreadDigest => ({ ...emptyDigest(), ...over });

function ctx(partial: {
  verified: VerifiedExtraction;
  lowest?: { vendorId: string; shop: string; pricePerDay: number } | null;
  digest?: ThreadDigest;
  rivals?: Array<{ vendorId: string; shop: string; pricePerDay: number; currency: string }>;
}): TurnContext {
  return {
    session: {
      sessionId: "s1",
      rfq: {
        vehicleClass: "scooter",
        engineSizeCc: 125,
        transmission: "any",
        durationDays: 3,
        accessories: [],
        fulfillment: "any",
        vendorMessage: "",
      },
      currency: "THB",
      benchmark: null,
      lowest: partial.lowest ?? null,
      rivals: partial.rivals ?? [],
    },
    thread: { threadKey: "u:66", vendorId: "lll", shop: "LLL Koh Tao", digest: partial.digest ?? digest() },
    tail: [],
    inbound: { text: "", verified: partial.verified },
    legalMoves: [],
    guards: { maxRounds: 4 },
    event: "shop-message",
  };
}

const LOW = { vendorId: "lll", shop: "LLL Koh Tao", pricePerDay: 180 };

describe("who is the cheapest shop in this session", () => {
  it("our own quote at the session low counts as the low", () => {
    expect(atSessionLow(ctx({ verified: { found: true, pricePerDay: 180 }, lowest: LOW }))).toBe(true);
  });

  it("a quote UNDER the snapshot counts too - the ledger can lag a live drop", () => {
    // A shop that just moved 250 -> 170 while `lowest` still reads 180 is the
    // cheapest thing in the session, and `===` would have missed it.
    expect(atSessionLow(ctx({ verified: { found: true, pricePerDay: 170 }, lowest: LOW }))).toBe(true);
  });

  it("a dearer shop is not the low, and neither is a session with no prices", () => {
    expect(atSessionLow(ctx({ verified: { found: true, pricePerDay: 250 }, lowest: LOW }))).toBe(false);
    expect(atSessionLow(ctx({ verified: { found: true, pricePerDay: 180 }, lowest: null }))).toBe(false);
  });
});

describe("one nudge, then lock", () => {
  it("the FIRST push at the session low is still legal - shops move on a first ask", () => {
    const legal = legalMovesFor(ctx({ verified: { found: true, pricePerDay: 180 }, lowest: LOW }));
    expect(legal).toContain("bargain");
  });

  it("REPRODUCTION: the SECOND push is not - we would be bidding against ourselves", () => {
    const legal = legalMovesFor(
      ctx({
        verified: { found: true, pricePerDay: 180 },
        lowest: LOW,
        // Our own last message already asked for less than 180. That IS the
        // nudge - no counter to keep in sync, the thread remembers.
        digest: digest({ lastOutbound: ["Any chance of 160 a day for the 3 days?"] }),
      })
    );
    expect(legal).not.toContain("bargain");
  });

  it("...and the thread does not go quiet - it moves to terms", () => {
    const legal = legalMovesFor(
      ctx({
        verified: { found: true, pricePerDay: 180 },
        lowest: LOW,
        digest: digest({ lastOutbound: ["how about 160?"] }),
      })
    );
    expect(legal).toContain("deposit-probe");
    expect(legal[0]).not.toBe("silent");
  });

  it("a number that is NOT an ask does not burn the nudge", () => {
    // "3 days", "125cc" and a phone number are all smaller than the quote.
    // Only a number in the quote's own band reads as a price we asked for.
    const legal = legalMovesFor(
      ctx({
        verified: { found: true, pricePerDay: 180 },
        lowest: LOW,
        digest: digest({ lastOutbound: ["Hi! Looking for a 125cc automatic for 3 days"] }),
      })
    );
    expect(legal).toContain("bargain");
  });

  it("at a DEARER shop the same history changes nothing - keep pushing", () => {
    // The lock is about being the floor, not about having spoken before.
    const legal = legalMovesFor(
      ctx({
        verified: { found: true, pricePerDay: 250 },
        lowest: LOW,
        digest: digest({ lastOutbound: ["Any chance of 200 a day?"] }),
      })
    );
    expect(legal).toContain("bargain");
  });
});

describe("the leverage planner stops arguing with the floor", () => {
  const base = { rivals: [], quotePerDay: 180, currency: "THB", durationDays: 3, vehicleLabel: "automatic 125cc scooter" };

  it("REPRODUCTION: it used to fall through to its weakest card and push anyway", () => {
    // No cheaper rival exists (we ARE the cheapest), round 0, so only the
    // duration card qualified - strength 40 - and the agent told the cheapest
    // shop on the island that its price was a bit high.
    const without = planLeverage({ ...base, round: 0 });
    expect(leadCard(without)?.kind).toBe("duration");

    const withFloor = planLeverage({ ...base, round: 0, isSessionLow: true });
    expect(withFloor).toEqual([]);
    expect(leadCard(withFloor)).toBeNull();
  });

  it("but a BUNDLE ask survives - it is the one thing left that improves the deal", () => {
    const cards = planLeverage({ ...base, round: 2, isSessionLow: true });
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe("bundle");
    expect(cards[0].line).toMatch(/do not push the number again/i);
  });

  it("a genuinely cheaper rival still outranks everything when we are NOT the low", () => {
    const cards = planLeverage({
      ...base,
      quotePerDay: 250,
      rivals: [{ pricePerDay: 180, currency: "THB" }],
      round: 0,
    });
    expect(leadCard(cards)?.kind).toBe("rival");
  });
});
