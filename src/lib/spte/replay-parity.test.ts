import { describe, it, expect, vi } from "vitest";

// THE EVAL GATE HAS TO BE ABLE TO FREEZE THE NEW STATES.
//
// Wave 3 made the golden replay run the candidate through SPTE with production
// guards. A behaviour the gate cannot express is a behaviour the gate cannot
// protect, so the two verdicts this wave introduces - a shop that brushed us
// off, and a fact we did not trust - have to be freezable in a case exactly the
// way `declined` and a stubbed extraction already are.

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
  sbSelectStrict: async () => ({ rows: [] }),
  sbUpdate: async () => {},
  sbDelete: async () => true,
  sbDeleteReturning: async () => [],
  supabaseConfigured: () => false,
}));
vi.mock("../market", () => ({
  floorPriceFor: async () => ({ floor: 150, typical: 240, currency: "THB" }),
  vehicleKeyFor: () => "motorbike-125",
  regionKeysFor: () => ["chiang-mai"],
}));

import { replaySpteTurns } from "../simulate";

const RFQ = { vehicleClass: "scooter" as const, durationDays: 5 };
const FLOOR = { floor: 150, typical: 240, currency: "THB" };

describe("the replay gate can freeze a brush-off", () => {
  it("a deflecting turn replays as a graceful close, never a rate re-ask", async () => {
    const { turns } = await replaySpteTurns({
      turns: [
        {
          shopSays: "You should try asking other shops; maybe they'll give you one.",
          stubExtraction: { found: false, deflected: true, stance: "deflecting", confidence: "high" },
        },
      ],
      rfq: RFQ,
      floor: FLOOR,
    });
    expect(turns[0].move).toBe("graceful-close");
    expect(turns[0].legalMoves).toEqual(["graceful-close", "silent"]);
    expect(turns[0].ourReply ?? "").not.toMatch(/\?/);
  });

  it("...and the SAME message without the verdict still reproduces the failure", async () => {
    // Kept deliberately: this is what the engine did, and it is the difference
    // the comprehension pass makes - not a change to the rest of the ladder.
    const { turns } = await replaySpteTurns({
      turns: [
        {
          shopSays: "You should try asking other shops; maybe they'll give you one.",
          stubExtraction: { found: false, confidence: "high" },
        },
      ],
      rfq: RFQ,
      floor: FLOOR,
    });
    expect(turns[0].legalMoves).toContain("clarify");
    expect(turns[0].move).not.toBe("graceful-close");
  });
});

describe("the replay gate can freeze a fact we did not trust", () => {
  const doubt = [
    {
      subject: "deposit",
      reading: "they will hold the passport",
      question: "wait - you mean I can leave a passport OR 4,000 cash?",
      confidence: 0.5,
    },
  ];

  it("an ambiguous deposit replays as a confirming question, and waits", async () => {
    const { turns } = await replaySpteTurns({
      turns: [
        {
          shopSays: "Click 125 300 baht per day. We have deposit passport or money4000",
          stubExtraction: {
            found: true,
            pricePerDay: 300,
            currency: "THB",
            vehicleVerdict: "match",
            confidence: "high",
            uncertain: doubt,
          },
        },
      ],
      rfq: RFQ,
      floor: FLOOR,
    });
    expect(turns[0].legalMoves).toContain("confirm");
    expect(turns[0].move).toBe("confirm");
    expect(turns[0].ourReply).toBe(doubt[0].question);
  });

  it("the same message read cleanly bargains instead - the doubt is the difference", async () => {
    const { turns } = await replaySpteTurns({
      turns: [
        {
          shopSays: "Click 125 300 baht per day. We have deposit passport or money4000",
          stubExtraction: {
            found: true,
            pricePerDay: 300,
            currency: "THB",
            vehicleVerdict: "match",
            confidence: "high",
          },
        },
      ],
      rfq: RFQ,
      floor: FLOOR,
    });
    expect(turns[0].legalMoves).not.toContain("confirm");
    expect(turns[0].move).toBe("bargain");
  });

  it("ONCE: the second turn does not re-ask a subject already confirmed", async () => {
    // The digest carries across replay turns exactly as it now carries across
    // live turns, so `confirmAsked` is what bounds the third ledger state.
    const { turns } = await replaySpteTurns({
      turns: [
        {
          shopSays: "300 per day. deposit passport or money4000",
          stubExtraction: {
            found: true,
            pricePerDay: 300,
            currency: "THB",
            vehicleVerdict: "match",
            confidence: "high",
            uncertain: doubt,
          },
        },
        {
          shopSays: "yes yes deposit",
          stubExtraction: {
            found: true,
            pricePerDay: 300,
            currency: "THB",
            vehicleVerdict: "match",
            confidence: "medium",
            uncertain: doubt,
          },
        },
      ],
      rfq: RFQ,
      floor: FLOOR,
    });
    expect(turns[0].move).toBe("confirm");
    expect(turns[1].legalMoves).not.toContain("confirm");
    expect(turns[1].move).not.toBe("confirm");
  });
});
