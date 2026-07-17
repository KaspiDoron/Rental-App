import { describe, it, expect, vi } from "vitest";

// Engine-truth pins for the re-audit round:
//  - a BLOCKED bargain rolls its run budget back (the push retries instead of
//    silently dying with "already bargained 1x" while the shop heard nothing)
//  - the banned-phrase scrub can never ship a de-fanged bargain (numbers
//    stripped) - it blocks, and the rollback lets the next turn recompose

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

import { runGraphTurn } from "./engine";
import { newThreadState } from "./state";
import { DEFAULT_OVERLAY } from "../ops/overlay";
import type { ExtractedOffer } from "../agents";
import type { GraphIO, GraphTurnInput, NegotiationThreadState } from "./types";
import type { StructuredRFQ } from "../types";

const RFQ: StructuredRFQ = {
  vehicleClass: "motorbike",
  transmission: "manual",
  durationDays: 3,
  accessories: [],
  fulfillment: "any",
  vendorMessage: "",
  engineSizeCc: 125,
};

function makeIO(seed: NegotiationThreadState, rival?: number) {
  const sends: string[] = [];
  const events: string[] = [];
  let saved = seed;
  const io: GraphIO = {
    loadState: async () => ({ ...saved }),
    saveState: async (s) => {
      saved = s;
    },
    cheapestRival: async () => rival,
    sessionTable: async () =>
      rival
        ? [{ vendorId: "rival", vendorName: "Another shop", pricePerDay: rival, currency: "THB" }]
        : [],
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
    recordEvent: async ({ kind }) => {
      events.push(kind);
    },
    llmAllowed: false,
    now: () => 1_700_000_000_000,
  };
  return { io, sends, events, getState: () => saved };
}

function turnInput(over: Partial<GraphTurnInput>): GraphTurnInput {
  return {
    event: {
      kind: "inbound-text",
      threadKey: "u@x:66111",
      userEmail: "u@x",
      toDigits: "66111",
      shopMessage: "250 per day",
      images: [],
      audios: [],
    },
    ctx: {
      sender: "u@x",
      vendorId: "v1",
      vendorName: "Shop A",
      rfq: RFQ,
      region: "Chiang Mai, Thailand",
      plan: "free",
    },
    rfq: RFQ,
    currency: "THB",
    floorPrice: 150,
    floorTypical: 240,
    sessionClosed: false,
    history: "Us: hi 125cc 3 days?\nShop: 250 per day",
    priorOutbound: ["hi 125cc 3 days?"],
    legacyCounts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
    humanDelay: false,
    transcript: null,
    deadlineAt: 1_700_000_000_000 + 60_000,
    ...over,
  } as GraphTurnInput;
}

const extraction: ExtractedOffer = {
  found: true,
  matchesSpec: true,
  confidence: "high",
  currency: "THB",
  pricePerDay: 250,
} as ExtractedOffer;

const seed = () =>
  newThreadState({
    threadKey: "u@x:66111",
    userEmail: "u@x",
    vendorId: "v1",
    vendorName: "Shop A",
    toNumber: "66111",
  });

describe("blocked bargains never burn the run budget", () => {
  it("banned phrase over the rival number -> BLOCKED, rolled back, event recorded", async () => {
    const { io, sends, events, getState } = makeIO(
      {
        ...seed(),
        fields: {
          firmCount: 0,
          toneDegraded: false,
          rounds: 0,
          depositType: "cash",
          depositAmount: 4000,
          fulfillment: "on-shop",
        },
      },
      220 // rival - the composed bargain cites it
    );
    const result = await runGraphTurn(
      turnInput({
        extraction,
        usablePrice: 250,
        // The owner banned the literal "220" (pathological but possible via
        // Ops) - the scrub would de-fang the message. It must BLOCK instead.
        overlay: { ...DEFAULT_OVERLAY, bannedPhrases: ["220"] },
      }),
      io
    );
    expect(result.delivered?.delivered).toBe("blocked");
    expect(sends).toHaveLength(0); // nothing toothless went out
    expect(getState().nodeRuns["bargain"] ?? 0).toBe(0); // budget rolled back
    expect(events).toContain("bargain-blocked");
  });

  it("control: without the ban the same turn sends and consumes the run", async () => {
    const { io, sends, getState } = makeIO(
      {
        ...seed(),
        fields: {
          firmCount: 0,
          toneDegraded: false,
          rounds: 0,
          depositType: "cash",
          depositAmount: 4000,
          fulfillment: "on-shop",
        },
      },
      220
    );
    const result = await runGraphTurn(
      turnInput({ extraction, usablePrice: 250, overlay: { ...DEFAULT_OVERLAY } }),
      io
    );
    expect(result.delivered?.delivered).toBe("sent");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatch(/220/); // the rival lever survived to the wire
    expect(getState().nodeRuns["bargain"] ?? 0).toBe(1);
  });
});
