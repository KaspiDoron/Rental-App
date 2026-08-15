import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { legalMovesFor } from "./policy";
import { emptyDigest } from "./digest";
import type { TurnContext, VerifiedExtraction, ThreadDigest } from "./types";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// KO TAO, A & T RENTAL.
//
//   12:26  shop: "Sorry,we do already discount."
//   12:54  (nothing. 28 minutes, and the hunt ended.)
//
// That message carries no price, no question, no firm, no decline and no
// availability cue, so the only move the policy pushed was `clarify` - and the
// ask-once gate removed it, correctly: we had asked "price" in the opener and
// their reply has no price token to settle it. Empty move set, reflex
// `silent`, and `silent` schedules nothing. No inbound was due (they had
// answered), and nothing else ticks one specific thread. The thread simply
// stopped, one nudge away from a quote.
//
// Two halves to the fix, and it needs both: a move to come back WITH
// (`momentum`, which has had a template since the graph engine and was never
// made legal anywhere on the SPTE path), and something to come back ON (a
// wakeup the silent turn schedules itself).

const digest = (over: Partial<ThreadDigest> = {}): ThreadDigest => ({ ...emptyDigest(), ...over });

function ctx(partial: {
  verified: VerifiedExtraction;
  digest?: ThreadDigest;
  /** W4.3: `momentum` is a re-opening, so it belongs to the WAKEUP the silent
   *  turn schedules - not to the reply that answers a shop mid-sentence. */
  event?: TurnContext["event"];
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
      lowest: null,
      rivals: [],
    },
    thread: { threadKey: "u:66", vendorId: "at", shop: "A & T Rental", digest: partial.digest ?? digest() },
    tail: [],
    inbound: { text: "Sorry,we do already discount.", verified: partial.verified },
    legalMoves: [],
    guards: { maxRounds: 4 },
    event: partial.event ?? "shop-message",
  };
}

/** The ask-once gate has already retired the price question. */
const ASKED_PRICE = digest({
  ledger: {
    claims: [],
    known: [],
    outstanding: ["price"],
    owed: [],
  },
});

describe("a thread with no price is not a finished thread", () => {
  it("REPRODUCTION: the vague reply no longer ends in bare silence", () => {
    // The turn the shop spoke on still goes quiet - but it now schedules the
    // 3-minute wakeup below, and the wakeup is where the nudge lives.
    const legal = legalMovesFor(
      ctx({ verified: { found: false }, digest: ASKED_PRICE, event: "tick" })
    );
    expect(legal).toContain("momentum");
    expect(legal[0]).not.toBe("silent");
  });

  it("...but NEVER as a reply to a shop that just spoke (W4.3)", () => {
    // `momentum` renders "Hi again! Just checking in - any chance on that
    // better rate...". Nothing in its guard tested whether the shop had
    // replied THIS turn, so it was legal against a shop that had just
    // dismissed us - greeting someone ten seconds after they wrote to us,
    // which is proof nobody read the message. The thread still comes back:
    // silent -> wakeup -> tick -> momentum.
    const legal = legalMovesFor(
      ctx({ verified: { found: false }, digest: ASKED_PRICE, event: "shop-message" })
    );
    expect(legal).not.toContain("momentum");
    expect(legal).toEqual(["silent"]);
  });

  it("ONCE. A thread already nudged goes quiet, and stays quiet", () => {
    const legal = legalMovesFor(
      ctx({
        verified: { found: false },
        event: "tick",
        digest: digest({
          ...ASKED_PRICE,
          lastOutbound: ["Hi again! Just checking in - any chance on that better rate for 3 days?"],
        }),
      })
    );
    expect(legal).not.toContain("momentum");
    expect(legal).toEqual(["silent"]);
  });

  it("a shop that DECLINED is not nudged - that is pestering, not momentum", () => {
    const legal = legalMovesFor(
      ctx({ verified: { found: false, declined: true }, digest: ASKED_PRICE, event: "tick" })
    );
    expect(legal).not.toContain("momentum");
  });

  it("neither is a shop that sounded RELUCTANT (tone, finally read by something)", () => {
    // Tone has been computed on every turn since the engine shipped and
    // consumed by nothing on the primary path. A shop that was short with us
    // does not want a cheerful check-in three minutes later.
    const legal = legalMovesFor(
      ctx({
        verified: { found: false },
        event: "tick",
        digest: digest({ ...ASKED_PRICE, tone: "reluctant" }),
      })
    );
    expect(legal).not.toContain("momentum");
    expect(legal).toEqual(["silent"]);
  });

  it("neither is a shop that has already given us a price", () => {
    // With a price on the table there is always a real move, and `momentum`
    // must never displace one.
    const legal = legalMovesFor(
      ctx({ verified: { found: true, pricePerDay: 180 }, digest: ASKED_PRICE, event: "tick" })
    );
    expect(legal).not.toContain("momentum");
    expect(legal).toContain("bargain");
  });

  it("...including a price they gave EARLIER and did not repeat (W4.5)", () => {
    // The standing quote is a fact about the thread. Before the digest was
    // durable, a shop replying "ok for you?" wiped it, bargain went illegal
    // and the engine nudged a shop it was mid-negotiation with.
    const legal = legalMovesFor(
      ctx({
        verified: { found: false },
        event: "tick",
        digest: digest({ ...ASKED_PRICE, quotedPricePerDay: 180 }),
      })
    );
    expect(legal).not.toContain("momentum");
    expect(legal).toContain("bargain");
  });

  it("it is a LAST resort - anything real still outranks it", () => {
    const legal = legalMovesFor(ctx({ verified: { found: false, askedQuestion: true } }));
    expect(legal[0]).toBe("answer");
    expect(legal).not.toContain("momentum");
  });
});

describe("and something has to bring the thread back", () => {
  const live = readCode("src/lib/spte/live.ts");

  it("a silent turn with no price schedules its own return", () => {
    expect(live).toMatch(/const silentAndPriceless =/);
    expect(live).toMatch(/outcome\.move === "silent"/);
    // `silent` never scheduled anything: it is the reflex for "nothing is
    // owed", which is right for a finished thread and exactly wrong for this
    // one. The wakeup path already existed - only the strategic wait ever
    // reached it.
    expect(live).toMatch(/clampWaitMinutes\(outcome\.waitMinutes\) \?\? \(silentAndPriceless \? 3 : undefined\)/);
  });

  it("a declined or out-of-stock thread is NOT resurrected", () => {
    const block = live.slice(live.indexOf("const silentAndPriceless ="), live.indexOf("if (waitMinutes)"));
    expect(block).toMatch(/!tc\.inbound\.verified\.declined/);
    expect(block).toMatch(/!tc\.inbound\.verified\.shopUnavailable/);
  });

  it("the feed is told which kind of wait this is", () => {
    // The one wakeup reason said "giving the shop ~N min before the next
    // nudge" for both cases. Here we are not giving them room, we are coming
    // back for something they never sent.
    expect(live).toMatch(/no price from them yet - checking back in/);
  });
});

describe("the panel stops telling every shop the same story", () => {
  const page = readCode("src/app/page.tsx");

  it("an out-of-stock shop is not described as one we are asking a price of", () => {
    // The `replied` bucket keys on `lastInboundAt`, so a shop that has run out
    // and a shop that said no are both in it, and both got "No price yet -
    // your agent is asking for one."
    expect(page).toMatch(/v\.stage === "out-of-stock"/);
    expect(page).toMatch(/They have run out - your agent asked when they are back\./);
    expect(page).toMatch(/They passed on this one\./);
  });

  it("the new copy is translatable, like every other string", () => {
    const cat = readCode("src/lib/i18n-catalog.ts");
    expect(cat).toMatch(/They have run out - your agent asked when they are back\./);
    expect(cat).toMatch(/They passed on this one\./);
  });
});
