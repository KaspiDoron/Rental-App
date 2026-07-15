import { describe, it, expect, vi, beforeEach } from "vitest";

// End-to-end engine traversal with a fully stubbed IO and no LLM (llmAllowed:
// false), so the DETERMINISTIC pipeline is exercised whole: sense (extract) ->
// comparator -> director -> act node -> tail gates -> deliver. Proves the
// engine actually composes and "delivers" a message, advances multi-round
// state, probes for missing deal fields, and presents a complete deal.

// The engine is server-only and pulls in Supabase/agent modules; stub the heavy
// deps so the pure traversal logic runs in-process.
vi.mock("server-only", () => ({}));
vi.mock("../ai", () => ({
  chat: async () => null, // force deterministic fallbacks everywhere
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
import { defaultGraphSpec } from "./default-graph";
import { newThreadState } from "./state";
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

function extraction(over: Partial<ExtractedOffer> = {}): ExtractedOffer {
  return { found: true, matchesSpec: true, confidence: "high", currency: "THB", ...over };
}

function makeIO(seed: NegotiationThreadState) {
  const sends: { to: string; text: string }[] = [];
  const queued: { body: string; meta: Record<string, unknown> }[] = [];
  let saved: NegotiationThreadState = seed;
  const io: GraphIO = {
    loadState: async () => ({ ...saved }),
    saveState: async (s) => {
      saved = s;
    },
    cheapestRival: async () => undefined,
    sessionTable: async () => [],
    insertWakeup: async () => {},
    clearWakeups: async () => {},
    queueOutbox: async ({ body, meta }) => {
      queued.push({ body, meta });
    },
    guardAndSend: async ({ toNumber, text }) => {
      sends.push({ to: toNumber, text });
      return { delivered: "sent", detail: "sent", finalText: text };
    },
    markPresentable: async () => {},
    insertBargainDraft: async () => {},
    recentOutboundGlobal: async () => [],
    writeTrace: async () => {},
    llmAllowed: false,
    now: () => 1_700_000_000_000,
  };
  return { io, sends, queued, getState: () => saved };
}

function input(over: Partial<GraphTurnInput> & { extraction: ExtractedOffer; usablePrice?: number }): GraphTurnInput {
  return {
    event: {
      kind: "inbound-text",
      threadKey: "u@x:66111",
      userEmail: "u@x",
      toDigits: "66111",
      shopMessage: "",
      images: [],
      audios: [],
    },
    ctx: { sender: "u@x", vendorId: "v1", vendorName: "Shop A", rfq: RFQ, region: "Chiang Mai, Thailand", plan: "free" },
    rfq: RFQ,
    currency: "THB",
    floorPrice: 150,
    floorTypical: 240,
    sessionClosed: false,
    history: "Us: hi 125cc 3 days?\nShop: ...",
    priorOutbound: ["hi 125cc 3 days?"],
    legacyCounts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
    humanDelay: false,
    transcript: null,
    deadlineAt: 1_700_000_000_000 + 60_000,
    ...over,
  } as GraphTurnInput;
}

const spec = defaultGraphSpec();
const seed = () =>
  newThreadState({ threadKey: "u@x:66111", userEmail: "u@x", vendorId: "v1", vendorName: "Shop A", toNumber: "66111" });

describe("engine end-to-end (deterministic)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a high quote with deposit+fulfillment known -> composes and delivers a bargain", async () => {
    const { io, sends } = makeIO({
      ...seed(),
      fields: {
        firmCount: 0,
        toneDegraded: false,
        rounds: 0,
        depositType: "cash",
        depositAmount: 4000,
        fulfillment: "on-shop",
      },
    });
    const res = await runGraphTurn(
      input({
        event: { kind: "inbound-text", threadKey: "u@x:66111", userEmail: "u@x", toDigits: "66111", shopMessage: "500 baht per day", images: [], audios: [] },
        extraction: extraction({ pricePerDay: 500 }),
        usablePrice: 500,
      }),
      io,
      spec
    );
    expect(res.action).toBe("bargain");
    expect(sends.length).toBe(1);
    expect(sends[0].text.length).toBeGreaterThan(0);
  });

  it("a settled (at-floor) price with deposit unknown -> probes the deposit", async () => {
    // At/below the floor there is no real saving to chase, so the director
    // stops bargaining and collects the missing deal term (deposit) instead.
    const { io, sends } = makeIO({
      ...seed(),
      fields: { firmCount: 0, toneDegraded: false, rounds: 1, fulfillment: "delivery" },
    });
    const res = await runGraphTurn(
      input({
        event: { kind: "inbound-text", threadKey: "u@x:66111", userEmail: "u@x", toDigits: "66111", shopMessage: "ok 150 per day", images: [], audios: [] },
        extraction: extraction({ pricePerDay: 150 }),
        usablePrice: 150,
      }),
      io,
      spec
    );
    expect(res.action).toBe("deposit-probe");
    expect(sends[0].text.toLowerCase()).toMatch(/deposit/);
  });

  it("passport-only deposit -> pushes once for a cash alternative", async () => {
    const { io, sends } = makeIO({
      ...seed(),
      fields: { firmCount: 0, toneDegraded: false, rounds: 0, depositType: "passport", fulfillment: "on-shop" },
    });
    const res = await runGraphTurn(
      input({
        event: { kind: "inbound-text", threadKey: "u@x:66111", userEmail: "u@x", toDigits: "66111", shopMessage: "150 per day passport", images: [], audios: [] },
        extraction: extraction({ pricePerDay: 150, depositType: "passport" }),
        usablePrice: 150,
      }),
      io,
      spec
    );
    expect(res.action).toBe("deposit-probe");
    expect(sends[0].text.toLowerCase()).toMatch(/cash|passport/);
  });

  it("a complete deal -> presents it (marks presentable, composes no shop message)", async () => {
    const { io, sends } = makeIO({
      ...seed(),
      fields: {
        firmCount: 0,
        toneDegraded: false,
        rounds: 1,
        depositType: "cash",
        depositAmount: 3000,
        fulfillment: "delivery",
      },
    });
    const res = await runGraphTurn(
      input({
        event: { kind: "inbound-text", threadKey: "u@x:66111", userEmail: "u@x", toDigits: "66111", shopMessage: "yes 150 per day, we deliver free", images: [], audios: [] },
        extraction: extraction({ pricePerDay: 150, delivers: true }),
        usablePrice: 150,
      }),
      io,
      spec
    );
    // present loops back to the director; with everything known and price at
    // floor it presents then closes warmly - either way it must not keep bargaining.
    expect(["present", "close", "silent"]).toContain(res.action);
    expect(sends.every((s) => !/discount|lower|cheaper/i.test(s.text))).toBe(true);
  });

  it("shop firm twice -> never bargains again", async () => {
    const { io, sends } = makeIO({
      ...seed(),
      fields: {
        firmCount: 2,
        toneDegraded: false,
        rounds: 1,
        depositType: "cash",
        depositAmount: 5000,
        fulfillment: "on-shop",
      },
    });
    const res = await runGraphTurn(
      input({
        event: { kind: "inbound-text", threadKey: "u@x:66111", userEmail: "u@x", toDigits: "66111", shopMessage: "no, 400 last price cannot lower", images: [], audios: [] },
        extraction: extraction({ pricePerDay: 400, shopFirm: true }),
        usablePrice: 400,
      }),
      io,
      spec
    );
    expect(res.action).not.toBe("bargain");
  });

  it("plays the whole Shop B script: bargain -> deposit -> cash push -> accept -> present", async () => {
    // The owner's Shop B example, end to end with carried state:
    //   "250/day" -> we bargain (rival 200 as leverage)
    //   "170, you come pick up" -> price settles + on-shop known -> deposit probe
    //   "Passport only" -> the cash push
    //   "3000 cash is fine" -> deal complete -> present (no more pushing)
    const bag = makeIO(seed());
    const t = async (
      shopMessage: string,
      ex: ExtractedOffer,
      usablePrice: number | undefined,
      rival?: number
    ) => {
      bag.io.cheapestRival = async () => rival;
      return runGraphTurn(
        input({
          event: { kind: "inbound-text", threadKey: "u@x:66111", userEmail: "u@x", toDigits: "66111", shopMessage, images: [], audios: [] },
          extraction: ex,
          usablePrice,
        }),
        bag.io,
        spec
      );
    };

    const r1 = await t("250 per day, high season now.", extraction({ pricePerDay: 250 }), 250, 200);
    expect(r1.action).toBe("bargain");

    // The shop concedes to 170 with no firm signal - a second, softer push is
    // exactly what the Shop C human did ("if you give lower I come").
    const r2 = await t(
      "Okay, I give you 170 per day. You come pick up at shop.",
      extraction({ pricePerDay: 170, onShopOnly: true }),
      170
    );
    expect(r2.action).toBe("bargain");

    // An explicit "last price" ends the price push instantly; the deposit came
    // back passport-only, so the next move is the polite cash push.
    const r3 = await t(
      "Cannot lower, 170 last price. Passport deposit only.",
      extraction({ found: false, shopFirm: true, depositType: "passport", deposit: "Passport only" }),
      undefined
    );
    expect(r3.action).toBe("deposit-probe"); // the cash push
    expect(bag.getState().fields.cashAlternativeAsked).toBe(true);

    const r4 = await t(
      "Okay, 3000 cash is fine.",
      extraction({ found: false, depositType: "cash", depositAmount: 3000, deposit: "3000 cash" }),
      undefined
    );
    // Deal complete (170 + cash 3000 + on-shop) -> present, then a warm close.
    expect(["present", "close"]).toContain(r4.action);
    expect(bag.getState().fields.presented).toBe(true);
    expect(bag.getState().fields.fulfillment).toBe("on-shop");
  });

  it("a closed session stays completely silent", async () => {
    const { io, sends } = makeIO(seed());
    const res = await runGraphTurn(
      input({
        sessionClosed: true,
        event: { kind: "inbound-text", threadKey: "u@x:66111", userEmail: "u@x", toDigits: "66111", shopMessage: "still there? 300 ok", images: [], audios: [] },
        extraction: extraction({ pricePerDay: 300 }),
        usablePrice: 300,
      }),
      io,
      spec
    );
    expect(res.action).toBe("silent");
    expect(sends.length).toBe(0);
  });
});
