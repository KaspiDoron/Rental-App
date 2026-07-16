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
    // The decision ladder explains every rung: the chosen one and why the
    // earlier (skipped) rungs did not fire - the Playground's "why?" view.
    expect(res.ladder && res.ladder.length).toBeTruthy();
    const chosen = res.ladder!.find((r) => r.chosen);
    expect(chosen?.toNodeId).toBe("bargain");
    const skipped = res.ladder!.filter((r) => !r.legal);
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((r) => r.why.length > 0)).toBe(true);
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
    //   "170, you come pick up" -> still 20 over the floor -> ONE more
    //     proportionate micro-ask (the gap-aware ladder: 155)
    //   "Cannot lower, 170 last price. Passport only" -> firm with no leverage
    //     left -> the push ends, the cash push follows
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
    // The playbook opener asks the FLOOR itself (150), not a compromise.
    expect(bag.getState().fields.lastTarget).toBe(150);

    // The shop concedes to 170 - still 20 above the 150 floor. The gap-aware
    // ladder keeps chasing realistic room with a proportionate micro-ask
    // (floor + a quarter of the remaining gap = 155) instead of dead-ending.
    const r2 = await t(
      "Okay, I give you 170 per day. You come pick up at shop.",
      extraction({ pricePerDay: 170, onShopOnly: true }),
      170
    );
    expect(r2.action).toBe("bargain");
    expect(bag.getState().fields.lastTarget).toBe(155);

    // A firm "last price" with no leverage left (170 is not far above the
    // floor, no cheaper rival) ends the push - the polite cash push follows.
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

  it("a firm line BEFORE any price never freezes the bargain (owner's screenshot bug)", async () => {
    // "Cannot lower, last price" arrived before any number existed - that must
    // NOT count as firm, and the 300-vs-150-floor quote right after MUST be
    // pushed, not accepted.
    const bag = makeIO(seed());
    await runGraphTurn(
      input({
        event: { kind: "inbound-text", threadKey: "u@x:66111", userEmail: "u@x", toDigits: "66111", shopMessage: "Cannot lower, last price", images: [], audios: [] },
        extraction: extraction({ found: false, shopFirm: true }),
        usablePrice: undefined,
      }),
      bag.io,
      spec
    );
    expect(bag.getState().fields.firmCount).toBe(0);

    const r2 = await runGraphTurn(
      input({
        event: { kind: "inbound-text", threadKey: "u@x:66111", userEmail: "u@x", toDigits: "66111", shopMessage: "300 per day", images: [], audios: [] },
        extraction: extraction({ pricePerDay: 300 }),
        usablePrice: 300,
      }),
      bag.io,
      spec
    );
    expect(r2.action).toBe("bargain");
    // The opener asks the real floor itself.
    expect(bag.getState().fields.lastTarget).toBe(150);
  });

  it("a bare 'Yes.' never dead-ends: momentum keeps the qualification moving", async () => {
    // The owner's screenshot bug: the shop answered "Yes." and the agent went
    // quiet forever. A confirmation is the BEGINNING of qualification - after
    // the one allowed clarify, the momentum keeper must still ask for the most
    // useful missing thing instead of falling into terminal silence.
    const bag = makeIO({
      ...seed(),
      nodeRuns: { clarify: 2 }, // clarify budget exhausted (maxRunsPerThread 2)
    });
    const res = await runGraphTurn(
      input({
        event: { kind: "inbound-text", threadKey: "u@x:66111", userEmail: "u@x", toDigits: "66111", shopMessage: "Yes.", images: [], audios: [] },
        extraction: extraction({ found: false, clarifyMessage: "Is that per day?" }),
        usablePrice: undefined,
      }),
      bag.io,
      spec
    );
    expect(res.action).toBe("momentum");
    expect(bag.sends.length).toBe(1);
    // No price yet -> it re-anchors on the missing price.
    expect(bag.sends[0].text.toLowerCase()).toMatch(/price|day/);
  });

  it("momentum confirms + asks to hold when the deal is complete but close is spent", async () => {
    const bag = makeIO({
      ...seed(),
      nodeRuns: { close: 2, present: 1 },
      fields: {
        firmCount: 0,
        toneDegraded: false,
        rounds: 1,
        pricePerDay: 150,
        currency: "THB",
        depositType: "cash",
        depositAmount: 3000,
        fulfillment: "on-shop",
        presented: true,
      },
    });
    const res = await runGraphTurn(
      input({
        event: { kind: "inbound-text", threadKey: "u@x:66111", userEmail: "u@x", toDigits: "66111", shopMessage: "Yes.", images: [], audios: [] },
        extraction: extraction({ found: false, clarifyMessage: "Anything else?" }),
        usablePrice: undefined,
      }),
      bag.io,
      spec
    );
    expect(res.action).toBe("momentum");
    // It must confirm, never accept: "hold" language, no booking commitment.
    expect(bag.sends[0].text).toMatch(/150/);
  });

  it("a cheaper rival justifies one more push past a single firm signal", async () => {
    // Shop is firm ONCE at 200 (not far above the 150 floor x1.25 = 187.5
    // alone would pass too, so use 190 to isolate the rival branch) - with a
    // REAL rival at 180 the bargain stays legal and the deterministic path
    // records the honest leverage note.
    const bag = makeIO({
      ...seed(),
      fields: {
        firmCount: 1,
        toneDegraded: false,
        rounds: 1,
        pricePerDay: 190,
        depositType: "cash",
        depositAmount: 3000,
        fulfillment: "on-shop",
      },
    });
    bag.io.cheapestRival = async () => 180;
    const res = await runGraphTurn(
      input({
        event: { kind: "inbound-text", threadKey: "u@x:66111", userEmail: "u@x", toDigits: "66111", shopMessage: "190 is my price.", images: [], audios: [] },
        extraction: extraction({ pricePerDay: 190 }),
        usablePrice: 190,
      }),
      bag.io,
      spec
    );
    expect(res.action).toBe("bargain");
    // The deterministic path preserves the cross-shop leverage honestly.
    expect(bag.getState().fields.lastLeverage).toMatch(/180/);
    // The rival caps the ask - never invented, never below the floor.
    expect(bag.getState().fields.lastTarget).toBeLessThanOrEqual(180);
  });

  it("two firm signals end the push even with a cheaper rival", async () => {
    const bag = makeIO({
      ...seed(),
      fields: {
        firmCount: 2,
        toneDegraded: false,
        rounds: 1,
        pricePerDay: 300,
        depositType: "cash",
        depositAmount: 3000,
        fulfillment: "on-shop",
      },
    });
    bag.io.cheapestRival = async () => 180;
    const res = await runGraphTurn(
      input({
        event: { kind: "inbound-text", threadKey: "u@x:66111", userEmail: "u@x", toDigits: "66111", shopMessage: "300, final.", images: [], audios: [] },
        extraction: extraction({ pricePerDay: 300, shopFirm: true }),
        usablePrice: 300,
      }),
      bag.io,
      spec
    );
    expect(res.action).not.toBe("bargain");
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
