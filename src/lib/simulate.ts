// Dry-run pipeline simulator - runs a HYPOTHETICAL shop reply through the EXACT
// same digraph engine the live loop uses (sense -> director -> act -> tail),
// returning every traversed node's input/reasoning/output, WITHOUT touching the
// database or sending a single WhatsApp message. This is the owner's enterprise
// test bench for the graph + prompts, in Admin -> Agents (Pipeline Studio).

import "server-only";
import { extractOffer, currencyForRegion } from "./agents";
import { chat } from "./ai";
import { floorPriceFor } from "./market";
import type { TraceRow } from "./orchestrator";
import { runGraphTurn, getGraphSpec, type DecisionLadderRung } from "./graph/engine";
import { newThreadState, threadKeyFor, applyExtractionToState } from "./graph/state";
import type {
  DeliverResult,
  GraphIO,
  GraphSpec,
  NegotiationThreadState,
  SessionShopRow,
} from "./graph/types";
import type { StructuredRFQ } from "./types";

export interface SimTurn {
  role: "shop" | "us";
  text: string;
}
export interface SimInput {
  shopReply?: string;
  rfq?: Partial<StructuredRFQ>;
  region?: string;
  priorThread?: SimTurn[];
  imageKind?: "vehicle" | "price_sheet" | "document" | "other";
  // Optional state overrides so the owner can jump straight to a scenario
  // ("price known, deposit unknown", "shop firm twice", "passport only").
  stateOverrides?: Partial<NegotiationThreadState["fields"]>;
  // A cheaper rival offer from a sibling shop (cross-shop leverage test).
  rivalPricePerDay?: number;
  transcript?: string; // simulate a voice-note transcript
}
export interface SimStage {
  stage: string;
  nodeId?: string;
  edgeId?: string;
  input: string;
  reasoning: string;
  output: string;
  verdict?: string;
  // Milliseconds this stage took (the Studio debugger's latency column).
  ms?: number;
}
export interface SimResult {
  direction: string;
  finalMessage: string | null;
  currency: string;
  path: string[]; // ordered node ids the engine traversed
  stages: SimStage[];
}

const DEFAULT_RFQ: StructuredRFQ = {
  vehicleClass: "scooter",
  transmission: "automatic",
  durationDays: 3,
  accessories: [],
  fulfillment: "any",
  vendorMessage: "",
  engineSizeCc: 110,
};

export async function simulatePipeline(input: SimInput): Promise<SimResult> {
  const rfq: StructuredRFQ = { ...DEFAULT_RFQ, ...(input.rfq ?? {}) };
  const region = (input.region ?? "").trim() || undefined;
  const thread = input.priorThread ?? [];
  const shopText = input.shopReply || (input.transcript ? `(voice note) ${input.transcript}` : "");
  const history = [
    ...thread.map((t) => `${t.role === "us" ? "Us" : "Shop"}: ${t.text}`),
    `Shop: ${input.shopReply || input.transcript || "(media)"}`,
  ].join("\n");

  // Real extraction (vision is skipped in a dry run - the owner picks imageKind).
  const extraction = await extractOffer(
    rfq,
    shopText || "(price-list photo)",
    [],
    history,
    region
  );
  if (input.imageKind) extraction.imageKind = input.imageKind;
  const cur = extraction.currency || currencyForRegion(region) || "USD";
  let usablePrice = extraction.found && extraction.pricePerDay ? extraction.pricePerDay : undefined;

  const floor = await floorPriceFor(region, rfq).catch(() => null);
  const floorSameCur = floor && floor.currency === cur ? floor : null;
  if (usablePrice && rfq.durationDays > 1 && floorSameCur) {
    const typical = floorSameCur.typical ?? Math.round(floorSameCur.floor * 1.6);
    const perDayIfTotal = Math.round(usablePrice / rfq.durationDays);
    if (usablePrice >= typical * 2 && perDayIfTotal >= floorSameCur.floor * 0.55) {
      usablePrice = perDayIfTotal;
    }
  }

  // Seed the thread state, layering the extraction, prior turns and overrides.
  const threadKey = threadKeyFor("sim@wheeldeal", "0000");
  let seed = newThreadState({
    threadKey,
    userEmail: "sim@wheeldeal",
    vendorId: "sim-shop",
    vendorName: "Test Shop",
    toNumber: "0000",
  });
  // Replay prior "us" bargains into the round counter so multi-round scenarios
  // behave (an already-asked thread should soften or stop).
  const priorBargains = thread.filter(
    (t) => t.role === "us" && /best|discount|how about|can you do|possible|cheaper|lower|per day|\/day/.test(t.text.toLowerCase())
  ).length;
  seed = applyExtractionToState(seed, extraction, usablePrice, cur);
  seed.fields = { ...seed.fields, rounds: priorBargains, ...(input.stateOverrides ?? {}) };

  const captured: NegotiationThreadState[] = [];
  const traces: TraceRow[] = [];
  const spec: GraphSpec = await getGraphSpec();

  const io: GraphIO = {
    loadState: async () => ({ ...seed }),
    saveState: async (s) => {
      captured.push(s);
    },
    cheapestRival: async () => input.rivalPricePerDay,
    sessionTable: async (): Promise<SessionShopRow[]> =>
      input.rivalPricePerDay
        ? [
            { vendorId: "sim-shop", vendorName: "Test Shop", pricePerDay: usablePrice, currency: cur, isThisShop: true },
            { vendorId: "rival", vendorName: "Another shop", pricePerDay: input.rivalPricePerDay, currency: cur },
          ]
        : [],
    insertWakeup: async () => {},
    clearWakeups: async () => {},
    queueOutbox: async () => {},
    guardAndSend: async ({ text }): Promise<DeliverResult> => ({
      delivered: "sent",
      detail: "(dry run - would send)",
      finalText: text,
    }),
    markPresentable: async () => {},
    insertBargainDraft: async () => {},
    recentOutboundGlobal: async () => [],
    writeTrace: async (rows) => {
      traces.push(...rows);
    },
    llmAllowed: true,
    now: () => 1_700_000_000_000, // fixed clock: deterministic dry runs
  };

  const result = await runGraphTurn(
    {
      event: {
        kind: input.transcript ? "inbound-audio" : input.imageKind ? "inbound-image" : "inbound-text",
        threadKey,
        userEmail: "sim@wheeldeal",
        toDigits: "0000",
        shopMessage: shopText,
        images: input.imageKind ? [{ mime: "image/jpeg", base64: "" }] : [],
        audios: input.transcript ? [{ mime: "audio/ogg", base64: "" }] : [],
      },
      ctx: {
        sender: "sim@wheeldeal",
        vendorId: "sim-shop",
        vendorName: "Test Shop",
        rfq,
        region,
        plan: "ultra",
      },
      rfq,
      extraction,
      usablePrice,
      currency: cur,
      floorPrice: floorSameCur?.floor,
      floorTypical: floorSameCur?.typical ?? undefined,
      sessionClosed: false,
      history,
      priorOutbound: thread.filter((t) => t.role === "us").map((t) => t.text),
      legacyCounts: { clarify: 0, bargain: priorBargains, answer: 0, close: 0 },
      humanDelay: false,
      transcript: input.transcript ? { text: input.transcript, source: "sim" } : null,
      deadlineAt: 1_700_000_000_000 + 60_000,
    },
    io,
    spec
  );

  const stages: SimStage[] = traces.map((t) => ({
    stage: t.stage,
    nodeId: t.nodeId,
    edgeId: t.edgeId,
    input: t.input,
    reasoning: t.reasoning,
    output: t.output,
    verdict: t.verdict,
  }));
  const path = traces.filter((t) => t.nodeId).map((t) => t.nodeId!) as string[];

  return {
    direction: result.action,
    finalMessage: result.message ?? null,
    currency: cur,
    path,
    stages,
  };
}

// ---------------------------------------------------------------------------
// Multi-turn conversation player - the owner's "watch a whole negotiation"
// button. Plays a scripted rental shop (the owner's real example transcripts)
// against the REAL engine turn by turn, carrying the SAME thread state across
// turns - so the flow (bargain -> leverage -> deposit -> cash push ->
// fulfillment -> present -> close) is visible end to end.
// ---------------------------------------------------------------------------

export interface ConversationTurn {
  shopSays: string;
  // Simulate a voice note (the text is treated as its transcript).
  voice?: boolean;
  // Simulate an attached photo of the vehicle / a price sheet.
  imageKind?: "vehicle" | "price_sheet";
  // A rival offer that exists in the session BY this turn (cross-shop leverage).
  rivalPricePerDay?: number;
}

export interface PlayedTurn {
  shopSays: string;
  voice?: boolean;
  imageKind?: string;
  action: string;
  ourReply: string | null;
  path: string[];
  // The Director's full ladder at decision time - every move, picked/skipped,
  // with a plain-language reason (the Playground's "why?" view).
  ladder?: DecisionLadderRung[];
  state: {
    pricePerDay?: number;
    currency?: string;
    depositType?: string;
    depositAmount?: number;
    fulfillment?: string | null;
    rounds: number;
    firmCount: number;
    dealComplete: boolean;
    // Full deal memory (Studio debugger): what the thread remembers.
    lastTarget?: number;
    lastLeverage?: string;
    mileageKm?: number;
    conditionNotes?: string;
    toneDegraded?: boolean;
    nodeRuns?: Record<string, number>;
    phase?: string;
    waitingUntil?: string | null;
  };
  stages: SimStage[];
}

/**
 * One shop turn through the REAL engine with carried state + history. The
 * shared core of the scripted Scenario Player AND the interactive Playground.
 */
async function playSingleTurn(args: {
  turn: ConversationTurn;
  rfq: StructuredRFQ;
  region?: string;
  spec: GraphSpec;
  carried: NegotiationThreadState;
  historyLines: string[];
}): Promise<{ played: PlayedTurn; carried: NegotiationThreadState }> {
  const { turn, rfq, region, spec } = args;
  let carried = args.carried;
  const historyLines = args.historyLines;
  const threadKey = carried.threadKey;

  const shopText = turn.voice ? `(voice note) ${turn.shopSays}` : turn.shopSays;
  historyLines.push(`Shop: ${turn.shopSays || "(photo)"}`);
  const history = historyLines.join("\n");

  const extraction = await extractOffer(
    rfq,
    shopText || "(price-list photo)",
    [],
    history,
    region
  );
  if (turn.imageKind) extraction.imageKind = turn.imageKind;
  const cur = extraction.currency || carried.fields.currency || currencyForRegion(region) || "USD";
  let usablePrice =
    extraction.found && extraction.pricePerDay ? extraction.pricePerDay : undefined;
  const floor = await floorPriceFor(region, rfq).catch(() => null);
  const floorSameCur = floor && floor.currency === cur ? floor : null;
  if (usablePrice && rfq.durationDays > 1 && floorSameCur) {
    const typical = floorSameCur.typical ?? Math.round(floorSameCur.floor * 1.6);
    const perDayIfTotal = Math.round(usablePrice / rfq.durationDays);
    if (usablePrice >= typical * 2 && perDayIfTotal >= floorSameCur.floor * 0.55) {
      usablePrice = perDayIfTotal;
    }
  }

  const traces: TraceRow[] = [];
  const io: GraphIO = {
    loadState: async () => ({ ...carried }),
    saveState: async (s) => {
      carried = s;
    },
    cheapestRival: async () => turn.rivalPricePerDay,
    sessionTable: async (): Promise<SessionShopRow[]> =>
      turn.rivalPricePerDay
        ? [
            { vendorId: "rival", vendorName: "Another shop", pricePerDay: turn.rivalPricePerDay, currency: cur },
          ]
        : [],
    insertWakeup: async () => {},
    clearWakeups: async () => {},
    queueOutbox: async () => {},
    guardAndSend: async ({ text }): Promise<DeliverResult> => ({
      delivered: "sent",
      detail: "(dry run)",
      finalText: text,
    }),
    markPresentable: async () => {},
    insertBargainDraft: async () => {},
    recentOutboundGlobal: async () => [],
    writeTrace: async (rows) => {
      traces.push(...rows);
    },
    llmAllowed: true,
    now: () => 1_700_000_000_000,
  };

  const result = await runGraphTurn(
    {
      event: {
        kind: turn.voice ? "inbound-audio" : turn.imageKind ? "inbound-image" : "inbound-text",
        threadKey,
        userEmail: "sim@wheeldeal",
        toDigits: "0000",
        shopMessage: shopText,
        images: turn.imageKind ? [{ mime: "image/jpeg", base64: "" }] : [],
        audios: turn.voice ? [{ mime: "audio/ogg", base64: "" }] : [],
      },
      ctx: { sender: "sim@wheeldeal", vendorId: "sim-shop", vendorName: carried.vendorName ?? "Test Shop", rfq, region, plan: "ultra" },
      rfq,
      extraction,
      usablePrice,
      currency: cur,
      floorPrice: floorSameCur?.floor,
      floorTypical: floorSameCur?.typical ?? undefined,
      sessionClosed: false,
      history,
      priorOutbound: historyLines.filter((l) => l.startsWith("Us: ")).map((l) => l.slice(4)),
      legacyCounts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
      humanDelay: false,
      transcript: turn.voice ? { text: turn.shopSays, source: "sim" } : null,
      deadlineAt: 1_700_000_000_000 + 60_000,
    },
    io,
    spec
  );

  if (result.message) historyLines.push(`Us: ${result.message}`);
  const f = carried.fields;
  const played: PlayedTurn = {
    shopSays: turn.shopSays,
    voice: turn.voice,
    imageKind: turn.imageKind,
    action: result.action,
    ourReply: result.message ?? null,
    path: traces.filter((t) => t.nodeId).map((t) => t.nodeId!) as string[],
    ladder: result.ladder,
    state: {
      pricePerDay: f.pricePerDay,
      currency: f.currency,
      depositType: f.depositType,
      depositAmount: f.depositAmount,
      fulfillment: f.fulfillment ?? null,
      rounds: f.rounds ?? 0,
      firmCount: f.firmCount ?? 0,
      dealComplete: Boolean(
        f.pricePerDay && (f.depositType || f.depositNote) && f.fulfillment
      ),
      // Full deal memory for the Studio debugger - everything the thread
      // remembers that shapes the next decision.
      lastTarget: f.lastTarget,
      lastLeverage: f.lastLeverage,
      mileageKm: f.mileageKm,
      conditionNotes: f.conditionNotes,
      toneDegraded: Boolean(f.toneDegraded),
      nodeRuns: { ...carried.nodeRuns },
      phase: carried.phase,
      waitingUntil: carried.waitingUntil ?? null,
    },
    stages: traces.map((t) => ({
      stage: t.stage,
      nodeId: t.nodeId,
      edgeId: t.edgeId,
      input: t.input,
      reasoning: t.reasoning,
      output: t.output,
      verdict: t.verdict,
      ms: t.ms,
    })),
  };
  return { played, carried };
}

export async function simulateConversation(args: {
  turns: ConversationTurn[];
  rfq?: Partial<StructuredRFQ>;
  region?: string;
}): Promise<{ turns: PlayedTurn[] }> {
  const rfq: StructuredRFQ = { ...DEFAULT_RFQ, ...(args.rfq ?? {}) };
  const region = (args.region ?? "").trim() || undefined;
  const threadKey = threadKeyFor("sim@wheeldeal", "0000");
  const spec: GraphSpec = await getGraphSpec();

  // One carried state + growing history across every turn.
  let carried = newThreadState({
    threadKey,
    userEmail: "sim@wheeldeal",
    vendorId: "sim-shop",
    vendorName: "Test Shop",
    toNumber: "0000",
  });
  const historyLines: string[] = ["Us: (opening request sent)"];
  const played: PlayedTurn[] = [];

  for (const turn of args.turns.slice(0, 10)) {
    const r = await playSingleTurn({ turn, rfq, region, spec, carried, historyLines });
    carried = r.carried;
    played.push(r.played);
  }
  return { turns: played };
}

// ---------------------------------------------------------------------------
// Interactive Playground - the owner ACTS AS the rental shop (or lets an AI
// play the shop) against the real engine, one turn at a time. The thread
// state + history round-trip through the client so each turn continues the
// same negotiation. Admin-only, dry-run IO, zero WhatsApp traffic.
// ---------------------------------------------------------------------------

export interface PlaygroundTurnInput {
  shopSays?: string;
  voice?: boolean;
  imageKind?: "vehicle" | "price_sheet";
  rivalPricePerDay?: number;
  rfq?: Partial<StructuredRFQ>;
  region?: string;
  carried?: unknown; // opaque round-tripped NegotiationThreadState
  historyLines?: string[];
  // AI-shop mode: an LLM invents the shop's next message from this persona.
  aiShop?: boolean;
  persona?: string;
}

export interface PlaygroundTurnResult {
  shopSays: string;
  aiGenerated: boolean;
  turn: PlayedTurn;
  carried: NegotiationThreadState;
  historyLines: string[];
}

/** Revive a client-round-tripped thread state defensively (shape-merge). */
function reviveCarried(raw: unknown): NegotiationThreadState {
  const base = newThreadState({
    threadKey: threadKeyFor("sim@wheeldeal", "0000"),
    userEmail: "sim@wheeldeal",
    vendorId: "sim-shop",
    vendorName: "Playground Shop",
    toNumber: "0000",
  });
  if (raw && typeof raw === "object") {
    const r = raw as Partial<NegotiationThreadState>;
    return {
      ...base,
      phase: typeof r.phase === "string" ? (r.phase as NegotiationThreadState["phase"]) : base.phase,
      fields: { ...base.fields, ...(r.fields && typeof r.fields === "object" ? r.fields : {}) },
      nodeRuns: r.nodeRuns && typeof r.nodeRuns === "object" ? { ...r.nodeRuns } : {},
    };
  }
  return base;
}

const DEFAULT_PERSONA =
  "You are a real motorbike/scooter rental shop owner in Southeast Asia chatting on WhatsApp. " +
  "Slightly broken English, short messages, friendly but you want the highest price. " +
  "Start around double the fair local price, concede slowly, prefer a passport deposit, " +
  "only reveal deposit/delivery details when asked.";

/** The AI plays the shop: invent the next SHOP message from the thread. */
async function aiShopReply(args: {
  persona?: string;
  historyLines: string[];
  rfq: StructuredRFQ;
  region?: string;
}): Promise<{ text: string; fromAi: boolean }> {
  const out = await chat(
    [
      {
        role: "system",
        content:
          `${(args.persona ?? "").trim() || DEFAULT_PERSONA}\n` +
          "Reply with ONE short WhatsApp message AS THE SHOP - no quotes, no explanations, " +
          "never break character, never mention being an AI.\n" +
          "PRICE DISCIPLINE (critical): a real shop NEVER lowers its price unprompted. " +
          "Only concede when the traveller explicitly pushed back on price or named a rival " +
          "offer - and then concede in SMALL steps toward your real bottom, never below it. " +
          "If the traveller did not push, repeat or defend your last price.",
      },
      {
        role: "user",
        content:
          `The traveller wants: ${args.rfq.engineSizeCc ?? ""}cc ${args.rfq.vehicleClass}, ` +
          `${args.rfq.durationDays} days${args.region ? `, in ${args.region}` : ""}.\n` +
          `Conversation so far ("Us" is the traveller's agent, you are "Shop"):\n` +
          `${args.historyLines.join("\n")}\n\nYour next message as the shop:`,
      },
    ],
    { maxTokens: 120 }
  );
  const text = (out ?? "").trim().replace(/^["']|["']$/g, "").slice(0, 400);
  if (text) return { text, fromAi: true };
  // Keyless fallback: a believable scripted shopkeeper, driven by what the
  // agent still needs - so the Playground works even before any AI key is set.
  return { text: "", fromAi: false };
}

function mockShopReply(carried: NegotiationThreadState, rfq: StructuredRFQ): string {
  const f = carried.fields;
  if (!f.pricePerDay) return `Yes have ${rfq.engineSizeCc ?? 125}cc. ${rfq.durationDays >= 7 ? "Weekly price special. " : ""}250 per day.`;
  if ((f.rounds ?? 0) > 0 && !f.depositType) return "Okay okay, for you 180 per day. Deposit passport.";
  if (f.depositType === "passport" && !f.cashAlternativeAsked) return "Passport only, everybody same.";
  if (f.depositType === "passport" && f.cashAlternativeAsked) return "Okay, 3000 cash deposit is fine.";
  if (!f.fulfillment) return "You come pick up at shop, we near beach road.";
  return "Okay see you, what time you come?";
}

export async function playgroundTurn(input: PlaygroundTurnInput): Promise<PlaygroundTurnResult> {
  const rfq: StructuredRFQ = { ...DEFAULT_RFQ, ...(input.rfq ?? {}) };
  const region = (input.region ?? "").trim() || undefined;
  const spec: GraphSpec = await getGraphSpec();
  const carried = reviveCarried(input.carried);
  const historyLines =
    Array.isArray(input.historyLines) && input.historyLines.length
      ? input.historyLines.map((l) => String(l).slice(0, 500)).slice(-40)
      : ["Us: (opening request sent)"];

  let shopSays = (input.shopSays ?? "").trim().slice(0, 1000);
  let aiGenerated = false;
  if (input.aiShop && !shopSays) {
    const ai = await aiShopReply({ persona: input.persona, historyLines, rfq, region });
    shopSays = ai.text || mockShopReply(carried, rfq);
    aiGenerated = true;
  }
  if (!shopSays && !input.imageKind) {
    shopSays = "Hello";
  }

  const r = await playSingleTurn({
    turn: {
      shopSays,
      voice: input.voice,
      imageKind: input.imageKind,
      rivalPricePerDay: input.rivalPricePerDay,
    },
    rfq,
    region,
    spec,
    carried,
    historyLines,
  });
  return { shopSays, aiGenerated, turn: r.played, carried: r.carried, historyLines };
}

// The owner's real example negotiations, playable end to end. These mirror the
// launch playbook: leverage from sibling shops, deposit probing, the
// passport->cash push, pickup/delivery/on-shop, voice + photo turns.
export const CONVERSATION_SCRIPTS: {
  id: string;
  label: string;
  rfq: Partial<StructuredRFQ>;
  region: string;
  turns: ConversationTurn[];
}[] = [
  {
    id: "shop-a-125",
    label: "Shop A - 125cc, 3 days (voice note + mileage)",
    rfq: { vehicleClass: "motorbike", engineSizeCc: 125, durationDays: 3 },
    region: "Chiang Mai, Thailand",
    turns: [
      { shopSays: "Yes, we have. New model 200 baht, old model 150 baht." },
      { shopSays: "No, new bike is very good, 200 last price. Old bike is 150, very strong." },
      { shopSays: "Hello, the bike is good condition, mileage is 35,000, come check it at shop", voice: true },
      { shopSays: "No, you come shop, we give you helmet. Deposit 3000 cash." },
    ],
  },
  {
    id: "shop-b-125",
    label: "Shop B - 125cc with 200 leverage (passport -> cash)",
    rfq: { vehicleClass: "motorbike", engineSizeCc: 125, durationDays: 3 },
    region: "Chiang Mai, Thailand",
    turns: [
      { shopSays: "250 per day, high season now.", rivalPricePerDay: 200 },
      { shopSays: "200? Maybe old bike. Okay, I give you 170 per day. You come pick up at shop.", rivalPricePerDay: 200 },
      { shopSays: "Passport only.", rivalPricePerDay: 200 },
      { shopSays: "Okay, 3000 cash is fine.", rivalPricePerDay: 200 },
    ],
  },
  {
    id: "shop-c-125",
    label: "Shop C - photo of old bike, 170 leverage",
    rfq: { vehicleClass: "motorbike", engineSizeCc: 125, durationDays: 3 },
    region: "Phuket, Thailand",
    turns: [
      { shopSays: "200 per day for everyone." },
      { shopSays: "", imageKind: "vehicle", rivalPricePerDay: 170 },
      { shopSays: "Okay, okay. You come now? I give new bike 160 per day, on shop only.", rivalPricePerDay: 170 },
      { shopSays: "Deposit 7000 cash.", rivalPricePerDay: 170 },
    ],
  },
  {
    id: "shop-d-nmax",
    label: "Shop D - Nmax week, firm shop, free delivery",
    rfq: { vehicleClass: "scooter", engineSizeCc: 155, durationDays: 7 },
    region: "Koh Samui, Thailand",
    turns: [
      { shopSays: "400 per day.", rivalPricePerDay: 300 },
      { shopSays: "We are honest shop, our bike maintenance is top. 390 per day last price, we bring to your hotel for free.", rivalPricePerDay: 300 },
      { shopSays: "No, cannot lower. Final price.", rivalPricePerDay: 300 },
      { shopSays: "Deposit 2000 cash.", rivalPricePerDay: 300 },
    ],
  },
];

// Named preset scenarios the owner can one-tap in the Studio, covering every
// branch + the new deal playbook + media.
export const SIM_SCENARIOS: { id: string; label: string; input: SimInput }[] = [
  { id: "thai-total", label: "Thai '3 day 900' (total vs per-day)", input: { shopReply: "scooter 900 for 3 day", region: "Chiang Mai, Thailand", rfq: { engineSizeCc: 125 } } },
  { id: "question", label: "Shop asks a question", input: { shopReply: "you want scooter or motorbike?", region: "Bali, Indonesia" } },
  { id: "great-price", label: "Great price (at floor) - close", input: { shopReply: "150 baht per day", region: "Chiang Mai, Thailand" } },
  { id: "bargain", label: "High quote - bargain toward floor", input: { shopReply: "500 baht per day", region: "Phuket, Thailand" } },
  { id: "leverage", label: "Cross-shop leverage (rival 170)", input: { shopReply: "250 baht per day", region: "Phuket, Thailand", rivalPricePerDay: 170 } },
  { id: "deposit-probe", label: "Price in, deposit unknown -> probe", input: { shopReply: "ok 200 per day", region: "Bali, Indonesia", stateOverrides: { pricePerDay: 200, currency: "IDR", fulfillment: "delivery" } } },
  { id: "passport-cash", label: "Passport only -> push for cash", input: { shopReply: "250 per day, passport deposit", region: "Bali, Indonesia", stateOverrides: { pricePerDay: 250, currency: "IDR", depositType: "passport", fulfillment: "on-shop" } } },
  { id: "fulfillment-probe", label: "Price + deposit in, ask delivery/pickup", input: { shopReply: "ok deposit 3000 cash", region: "Phuket, Thailand", stateOverrides: { pricePerDay: 200, currency: "THB", depositType: "cash", depositAmount: 3000 } } },
  { id: "complete-present", label: "All known -> present the deal", input: { shopReply: "yes we deliver free", region: "Bali, Indonesia", stateOverrides: { pricePerDay: 160, currency: "IDR", depositType: "cash", depositAmount: 7000, fulfillment: "delivery" } } },
  { id: "firm-twice", label: "Shop firm twice -> stop pushing", input: { shopReply: "no, last price, cannot lower", region: "Phuket, Thailand", stateOverrides: { pricePerDay: 400, currency: "THB", firmCount: 2, depositType: "cash", depositAmount: 4000, fulfillment: "on-shop" } } },
  { id: "vehicle-photo", label: "Vehicle photo (thank the shop)", input: { shopReply: "", imageKind: "vehicle", region: "Bali, Indonesia" } },
  { id: "price-sheet", label: "Price-sheet photo", input: { shopReply: "", imageKind: "price_sheet", region: "Bali, Indonesia" } },
  { id: "voice-note", label: "Voice note (transcript)", input: { transcript: "hello my friend, the bike is 200 baht per day, very good condition", region: "Chiang Mai, Thailand" } },
  { id: "after-ask", label: "After our ask - soften or stop", input: { shopReply: "sorry cannot, 400 is best", region: "Phuket, Thailand", priorThread: [{ role: "shop", text: "500 per day" }, { role: "us", text: "any chance for 350 per day? that would be perfect" }] } },
];
