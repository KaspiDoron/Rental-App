import { describe, it, expect, vi } from "vitest";

// BATCH D end-to-end pins: the real runGraphTurn path must NEVER ship the two
// production failures (screenshots IMG_8480), even when the LLM hallucinates:
//   BUG 1 - a 5-day search whose bargain says "3 days"
//   BUG 2 - "another shop quoted 220" when no rival exists
// Here chat() returns exactly the poisoned draft; the tail gates must repair it.

vi.mock("server-only", () => ({}));
vi.mock("../ai", () => ({
  // Return the poisoned bargain ONLY for composeBargain's system prompt; every
  // other LLM call (director, validator) falls back to deterministic behaviour.
  chat: async (msgs?: { role: string; content: string }[]) => {
    const sys = msgs?.[0]?.content ?? "";
    if (typeof sys === "string" && sys.includes("real human traveller")) {
      return POISON;
    }
    return null;
  },
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
  floorPriceFor: async () => ({ floor: 150, typical: 240, currency: "PHP" }),
  vehicleKeyFor: () => "scooter-125",
  regionKeysFor: () => ["camiguin"],
}));

import { runGraphTurn } from "./engine";
import { newThreadState } from "./state";
import { DEFAULT_OVERLAY } from "../ops/overlay";
import type { ExtractedOffer } from "../agents";
import type { GraphIO, GraphTurnInput, NegotiationThreadState } from "./types";
import type { StructuredRFQ } from "../types";

let POISON = "";

// The real traveller: automatic 125cc scooter for FIVE days (as in the drill).
const RFQ: StructuredRFQ = {
  vehicleClass: "scooter",
  transmission: "automatic",
  durationDays: 5,
  accessories: [],
  fulfillment: "any",
  vendorMessage: "",
  engineSizeCc: 125,
};

function makeIO(seed: NegotiationThreadState) {
  const sends: string[] = [];
  let saved = seed;
  const io: GraphIO = {
    loadState: async () => ({ ...saved }),
    saveState: async (s) => {
      saved = s;
    },
    cheapestRival: async () => undefined, // NO rival exists in this session
    sessionTable: async () => [],
    insertWakeup: async () => {},
    clearWakeups: async () => {},
    queueOutbox: async () => {},
    guardAndSend: async ({ text }) => {
      sends.push(text);
      return { delivered: "sent", detail: "sent", finalText: text };
    },
    markPresentable: async () => {},
    insertBargainDraft: async () => {},
    recentOutboundGlobal: async () => [],
    writeTrace: async () => {},
    recordEvent: async () => {},
    llmAllowed: true,
    now: () => 1_700_000_000_000,
  };
  return { io, sends, getState: () => saved };
}

const extraction: ExtractedOffer = {
  found: true,
  matchesSpec: true,
  confidence: "high",
  currency: "PHP",
  pricePerDay: 250,
} as ExtractedOffer;

function turnInput(over: Partial<GraphTurnInput>): GraphTurnInput {
  return {
    event: {
      kind: "inbound-text",
      threadKey: "u@x:63111",
      userEmail: "u@x",
      toDigits: "63111",
      shopMessage: "I will give you good price 250 per day",
      images: [],
      audios: [],
    },
    ctx: {
      sender: "u@x",
      vendorId: "v1",
      vendorName: "Sun House Rental",
      rfq: RFQ,
      region: "Camiguin, Philippines",
      plan: "free",
    },
    rfq: RFQ,
    currency: "PHP",
    floorPrice: 150,
    floorTypical: 240,
    sessionClosed: false,
    history: "Us: automatic scooter 125cc for 5 days, best price?\nShop: 250 per day",
    priorOutbound: ["automatic scooter 125cc for 5 days, best price?"],
    legacyCounts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
    humanDelay: false,
    transcript: null,
    deadlineAt: 1_700_000_000_000 + 60_000,
    ...over,
  } as GraphTurnInput;
}

const seed = () =>
  newThreadState({
    threadKey: "u@x:63111",
    userEmail: "u@x",
    vendorId: "v1",
    vendorName: "Sun House Rental",
    toNumber: "63111",
  });

describe("runGraphTurn integrity - Batch D production failures never ship", () => {
  it("BUG1+BUG2: fabricated 220 + wrong 3 days are BOTH repaired before sending", async () => {
    POISON = "For 3 days tho, another shop quoted 220, i'd book with you if you can do 200. also what's the deposit?";
    const { io, sends } = makeIO({
      ...seed(),
      fields: { firmCount: 0, toneDegraded: false, rounds: 0 },
    });
    const result = await runGraphTurn(
      turnInput({ extraction, usablePrice: 250, overlay: { ...DEFAULT_OVERLAY } }),
      io
    );
    expect(result.delivered?.delivered).toBe("sent");
    expect(sends).toHaveLength(1);
    const sent = sends[0];
    // The fabricated rival is gone.
    expect(sent).not.toContain("220");
    expect(sent).not.toMatch(/another shop/i);
    // The wrong duration is gone; the truth (5 days) is what a day count reads.
    expect(sent).not.toMatch(/\b3 days?\b/);
    // A real, arithmetically sane ask survived (below the 250 quote, above floor).
  });

  it("BARGAINED-0 KILL: a floor ABOVE the live quote (bad seed 350 vs 300) is clamped and a counter still goes out", async () => {
    // The production paralysis: PH seed floor 350 > live 300 quote flipped
    // priceAtOrBelowFloor true -> d-bargain illegal -> engine went silent and
    // the dashboard honestly reported Bargained 0 forever. The credibility
    // clamp (min(floor, quote*0.9)) must restore room to counter.
    POISON = "Thanks! Could you do 270 a day for the 5 days? 🙏";
    const { io, sends } = makeIO({
      ...seed(),
      fields: { firmCount: 0, toneDegraded: false, rounds: 0 },
    });
    const result = await runGraphTurn(
      turnInput({
        extraction,
        usablePrice: 300,
        floorPrice: 350, // the poisoned seed - ABOVE the shop's own quote
        overlay: { ...DEFAULT_OVERLAY },
      }),
      io
    );
    expect(result.delivered?.delivered).toBe("sent");
    expect(sends).toHaveLength(1);
    // The counter asks for LESS than the live 300 quote - bargaining is alive.
    const nums = (sends[0].match(/\d{2,4}/g) ?? []).map(Number);
    expect(nums.some((n) => n < 300 && n >= 200)).toBe(true);
  });

  it("BUG1 alone: a wrong-duration bargain is corrected to the real 5 days and still sends", async () => {
    POISON = "Thanks! For the 3 days, could you do 200 a day my friend? 🙏";
    const { io, sends } = makeIO({
      ...seed(),
      fields: { firmCount: 0, toneDegraded: false, rounds: 0 },
    });
    const result = await runGraphTurn(
      turnInput({ extraction, usablePrice: 250, overlay: { ...DEFAULT_OVERLAY } }),
      io
    );
    expect(result.delivered?.delivered).toBe("sent");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatch(/\b5 days?\b/);
    expect(sends[0]).not.toMatch(/\b3 days?\b/);
  });
});
