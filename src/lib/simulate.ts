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

// ---------------------------------------------------------------------------
// Sim rival selection - the PRODUCTION predicate, not a shortcut.
//
// The playground used to hand the typed rival price straight to the engine,
// bypassing the real selection rules (same currency, same vehicle class,
// different shop, strictly cheaper). That made live no-push bugs impossible
// to reproduce here. Every simulated rival - typed or listed - now flows
// through the same pickCheapestRival() the live engine uses.
// ---------------------------------------------------------------------------
import { pickCheapestRival, type RivalOffer } from "./search-session";

const SIM_EPOCH = "1970-01-01T00:00:00.000Z";

function simRivalIO(
  rivalOffers: RivalOffer[] | undefined,
  rivalPricePerDay: number | undefined,
  cur: string,
  usablePrice: number | undefined,
  thisVendorId: string
): {
  cheapestRival: GraphIO["cheapestRival"];
  sessionRows: (thisPrice?: number) => SessionShopRow[];
} {
  const offers: RivalOffer[] = [
    ...(rivalOffers ?? []),
    ...(typeof rivalPricePerDay === "number"
      ? [
          {
            vendorId: "rival",
            pricePerDay: rivalPricePerDay,
            currency: cur,
            createdAt: SIM_EPOCH,
          },
        ]
      : []),
  ];
  return {
    cheapestRival: async (args) =>
      pickCheapestRival(offers, {
        vendorId: args.vendorId || thisVendorId,
        currency: args.currency,
        vehicleKey: args.vehicleKey,
        belowPrice: args.belowPrice,
        sinceIso: SIM_EPOCH,
      }),
    sessionRows: (thisPrice) => [
      ...(thisPrice
        ? [
            {
              vendorId: thisVendorId,
              vendorName: "Test Shop",
              pricePerDay: thisPrice,
              currency: cur,
              isThisShop: true,
            },
          ]
        : []),
      ...offers.map((o, i) => ({
        vendorId: o.vendorId || `rival-${i}`,
        vendorName: "Another shop",
        pricePerDay: o.pricePerDay,
        currency: o.currency,
      })),
    ],
  };
}

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
  // Full sibling-shop offers (currency/vehicle-aware) - preferred over the
  // bare number; both flow through the production rival predicate.
  rivalOffers?: RivalOffer[];
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
    ...(() => {
      const sim = simRivalIO(input.rivalOffers, input.rivalPricePerDay, cur, usablePrice, "sim-shop");
      return {
        cheapestRival: sim.cheapestRival,
        sessionTable: async (): Promise<SessionShopRow[]> => sim.sessionRows(usablePrice),
      };
    })(),
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
  rivalOffers?: RivalOffer[];
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
    ...(() => {
      const sim = simRivalIO(turn.rivalOffers, turn.rivalPricePerDay, cur, usablePrice, "sim-shop");
      return {
        cheapestRival: sim.cheapestRival,
        sessionTable: async (): Promise<SessionShopRow[]> => sim.sessionRows(),
      };
    })(),
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

// ---------------------------------------------------------------------------
// DETERMINISTIC replay - the golden regression suite's runner.
//
// Unlike simulateConversation/playSingleTurn above (which call the live
// extractor + floor lookup and allow LLMs), this variant is BIT-STABLE:
// extraction and floor are frozen stubs captured when the golden case was
// created, llmAllowed is false (the director is the pure first-legal-edge
// function of spec+facts), the clock is frozen, and the policy overlay is
// pinned. Same case + same spec + same overlay => byte-identical output,
// which is what makes it usable as an eval gate for behavior changes.
// ---------------------------------------------------------------------------

export async function replayConversation(args: {
  turns: import("./ops/types").GoldenTurn[];
  rfq?: Partial<StructuredRFQ>;
  region?: string;
  floor?: { floor?: number; typical?: number; currency?: string } | null;
  spec?: GraphSpec;
  overlay?: import("./ops/overlay").PolicyOverlay;
}): Promise<{ turns: PlayedTurn[] }> {
  const rfq: StructuredRFQ = { ...DEFAULT_RFQ, ...(args.rfq ?? {}) };
  const region = (args.region ?? "").trim() || undefined;
  const threadKey = threadKeyFor("replay@wheeldeal", "0000");
  const spec: GraphSpec = args.spec ?? (await getGraphSpec());
  const { DEFAULT_OVERLAY } = await import("./ops/overlay");
  const overlay = args.overlay ?? DEFAULT_OVERLAY;

  let carried = newThreadState({
    threadKey,
    userEmail: "replay@wheeldeal",
    vendorId: "replay-shop",
    vendorName: "Golden Shop",
    toNumber: "0000",
  });
  const historyLines: string[] = ["Us: (opening request sent)"];
  const played: PlayedTurn[] = [];

  for (const turn of args.turns.slice(0, 10)) {
    const shopText = turn.voice ? `(voice note) ${turn.shopSays}` : turn.shopSays;
    historyLines.push(`Shop: ${turn.shopSays || "(photo)"}`);
    const history = historyLines.join("\n");

    // FROZEN extraction - exactly what the live extractor said at capture time.
    const stub = (turn.stubExtraction ?? {}) as Record<string, unknown>;
    const extraction = {
      found: false,
      confidence: "medium",
      ...stub,
    } as unknown as import("./agents").ExtractedOffer;
    if (turn.imageKind) extraction.imageKind = turn.imageKind as typeof extraction.imageKind;

    const cur =
      extraction.currency || carried.fields.currency || currencyForRegion(region) || "USD";
    const floorSameCur =
      args.floor && typeof args.floor.floor === "number" && (!args.floor.currency || args.floor.currency === cur)
        ? { floor: args.floor.floor, typical: args.floor.typical ?? undefined }
        : null;
    let usablePrice =
      extraction.found && extraction.pricePerDay ? extraction.pricePerDay : undefined;
    if (usablePrice && rfq.durationDays > 1 && floorSameCur) {
      // Same total-vs-per-day disambiguation as the live path, on frozen data.
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
      ...(() => {
        const sim = simRivalIO(turn.rivalOffers, turn.rivalPricePerDay, cur, usablePrice, "sim-shop");
        return {
          cheapestRival: sim.cheapestRival,
          sessionTable: async (): Promise<SessionShopRow[]> => sim.sessionRows(),
        };
      })(),
      insertWakeup: async () => {},
      clearWakeups: async () => {},
      queueOutbox: async () => {},
      guardAndSend: async ({ text }): Promise<DeliverResult> => ({
        delivered: "sent",
        detail: "(golden replay)",
        finalText: text,
      }),
      markPresentable: async () => {},
      insertBargainDraft: async () => {},
      recentOutboundGlobal: async () => [],
      writeTrace: async (rows) => {
        traces.push(...rows);
      },
      llmAllowed: false, // deterministic director + composers, always
      now: () => 1_700_000_000_000,
    };

    const result = await runGraphTurn(
      {
        event: {
          kind: turn.voice ? "inbound-audio" : turn.imageKind ? "inbound-image" : "inbound-text",
          threadKey,
          userEmail: "replay@wheeldeal",
          toDigits: "0000",
          shopMessage: shopText,
          images: turn.imageKind ? [{ mime: "image/jpeg", base64: "" }] : [],
          audios: turn.voice ? [{ mime: "audio/ogg", base64: "" }] : [],
        },
        ctx: {
          sender: "replay@wheeldeal",
          vendorId: "replay-shop",
          vendorName: "Golden Shop",
          rfq,
          region,
          plan: "ultra",
        },
        rfq,
        extraction,
        usablePrice,
        currency: cur,
        floorPrice: floorSameCur?.floor,
        floorTypical: floorSameCur?.typical,
        sessionClosed: false,
        history,
        priorOutbound: historyLines.filter((l) => l.startsWith("Us: ")).map((l) => l.slice(4)),
        legacyCounts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
        humanDelay: false,
        transcript: turn.voice ? { text: turn.shopSays, source: "golden" } : null,
        deadlineAt: 1_700_000_000_000 + 60_000,
        overlay,
      },
      io,
      spec
    );

    if (result.message) historyLines.push(`Us: ${result.message}`);
    const f = carried.fields;
    played.push({
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
        dealComplete: Boolean(f.pricePerDay && (f.depositType || f.depositNote) && f.fulfillment),
        lastTarget: f.lastTarget,
        lastLeverage: f.lastLeverage,
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
    });
  }
  return { turns: played };
}

// ---------------------------------------------------------------------------
// DETERMINISTIC replay for the PRIMARY engine (SPTE).
//
// replayConversation above drives the GRAPH engine, which is the dormant
// fallback. SPTE is what runs in production, so a suite that only gates the
// graph gates the wrong thing - "it can never regress" was not true for the
// engine that actually answers shops.
//
// Same discipline, none of the IO: the context is built straight from the
// frozen case (no DB, no network), `deterministic:true` stands in for
// `llmAllowed:false`, and the clock never appears. The legal move set, the
// post-rails and the digest merge are the REAL ones - only composition is
// frozen. Same case + same code => same moves, every run.
// ---------------------------------------------------------------------------

export interface PlayedSpteTurn {
  shopSays: string;
  move: import("./spte/types").MoveKind;
  legalMoves: import("./spte/types").MoveKind[];
  ourReply: string | null;
  optionCount: number;
  /** The session-low the turn was decided against (null = none yet). Exposed so
   *  the gate's tests can pin the live-parity session model, not just moves. */
  sessionLowest: number | null;
}

export async function replaySpteTurns(args: {
  turns: import("./ops/types").GoldenTurn[];
  rfq?: Partial<StructuredRFQ>;
  floor?: { floor?: number; typical?: number; currency?: string } | null;
  /** Candidate graph spec - the source of the owner-editable round cap. */
  spec?: GraphSpec;
  /** Candidate policy overlay. Defaults to DEFAULT_OVERLAY (bit-stable), the
   *  same pinned-default contract replayConversation uses - NOT live config. */
  overlay?: import("./ops/overlay").PolicyOverlay;
}): Promise<{ turns: PlayedSpteTurn[] }> {
  const { runTurn } = await import("./spte/orchestrator");
  const { emptyDigest } = await import("./spte/digest");
  const { optionsFromThread } = await import("./offer-options");
  const { deriveThreadFacts } = await import("./spte/thread-facts");
  const { buildLedger, stockState } = await import("./thread/ledger");
  const { validRivals, sessionFloor } = await import("./negotiation/session-rivals");
  const { DEFAULT_OVERLAY } = await import("./ops/overlay");
  const rfq: StructuredRFQ = { ...DEFAULT_RFQ, ...(args.rfq ?? {}) };
  // THE CANDIDATE'S POLICY, NOT PRODUCTION'S SHADOW. The gate exists to answer
  // "may this candidate ship?", so the SPTE replay runs under the candidate
  // overlay (priceFarAboveFloor + bannedPhrases reach the guards below, exactly
  // as live.ts resolvePolicy places them) and the candidate spec's round cap.
  // It used to run with NO overlay at all: the move validator sat at the 1.25
  // literal the overlay's own comment calls "far too soft" while live ran 1.08,
  // and the banned-phrase scrub was never exercised by the gate.
  const overlay = args.overlay ?? DEFAULT_OVERLAY;
  const maxRounds = args.spec
    ? args.spec.settings.maxRoundsPerShop
    : await getGraphSpec()
        .then((spec) => spec.settings.maxRoundsPerShop)
        .catch(() => 4);

  let digest = emptyDigest();
  const inboundSoFar: string[] = [];
  const outbound: string[] = [];
  // The stamped move of each outbound entry (undefined for case-carried ones).
  // Live derives handoverAsks/rounds from stamps, so replay stamps its own.
  const outboundKinds: (string | undefined)[] = [];
  const played: PlayedSpteTurn[] = [];
  // LIVE PARITY: the live glue derives firmCount from the WHOLE history
  // including the current inbound (live.ts deriveThreadFacts + the shopFirm
  // OR-in), while runTurn's outcome digest never carries it - so replay ran
  // every case at firmCount 0 and the two-firms-stop rule could not be
  // exercised by the golden gate at all. Accumulate the stub flags the way
  // live OR-s the extractor's read in; the text-derived count below joins via
  // max(), the same "trust whichever source saw more" shape live uses.
  let firmSoFar = 0;

  for (const turn of args.turns.slice(0, 10)) {
    const stub = (turn.stubExtraction ?? {}) as Record<string, unknown>;
    // OUR side of the frozen conversation (Wave 3, optional + additive): a case
    // may carry the message we had sent before this shop turn, which is what
    // makes the ask-once ledger gate and the at-floor lock reachable in replay.
    if (typeof turn.ourReplyBefore === "string" && turn.ourReplyBefore.trim()) {
      outbound.push(turn.ourReplyBefore);
      outboundKinds.push(undefined);
    }
    const priorInbound = [...inboundSoFar];
    inboundSoFar.push(turn.shopSays);
    const currency = (stub.currency as string) || args.floor?.currency || "THB";

    // Options are DERIVED from the thread, exactly as the live glue derives
    // them - a frozen case cannot hand-wave a menu into existence.
    const options = optionsFromThread(inboundSoFar, { durationDays: rfq.durationDays });

    // THREAD-DERIVED STATE, the same way live builds it (live.ts buildDigest):
    // deposit/fulfillment/handover facts, the anti-repetition memory and the
    // ledger all come from the message history the replay already holds. This
    // is what makes the ask-once gate, the logistics close-out and the
    // out-of-stock branch TESTABLE in the gate at all - the replayed context
    // used to carry none of them. Cases whose turns contain no such signals
    // derive today's values (false/empty), so existing cases replay identically.
    // MEANING COMES FROZEN, LIKE EVERY OTHER MODEL VERDICT (K). thread-facts
    // no longer reads the shop's words - a case that wants firmness/deposit/
    // handover facts freezes them on the stub (stub.comprehension), exactly
    // like stances and extractions. stub.firm keeps accumulating into
    // firmTurns for the existing cases that pinned it that way.
    const frozenComp = (stub.comprehension ?? undefined) as
      | import("./spte/types").DurableComprehension
      | undefined;
    const facts = deriveThreadFacts({
      outbound,
      outboundKinds,
      comprehension: frozenComp
        ? { ...frozenComp, firmTurns: Math.max(frozenComp.firmTurns ?? 0, firmSoFar) }
        : firmSoFar > 0
          ? { firmTurns: firmSoFar }
          : undefined,
    });
    // WHAT THE COMPREHENSION PASS SAID, FROZEN (W4.3/W4.4). Replay never calls
    // a model, so a case that wants to exercise the deflection branch or the
    // confirm ladder freezes the verdict the same way it freezes an extraction.
    // Absent on every existing case -> undefined/empty, so they replay
    // byte-identically.
    const uncertain = Array.isArray(stub.uncertain)
      ? (stub.uncertain as import("./spte/types").Uncertainty[])
      : undefined;
    const ambiguous = (uncertain ?? [])
      .map((u) => u.subject)
      .filter((s): s is "deposit" | "price" | "availability" =>
        s === "deposit" || s === "price" || s === "availability"
      );
    const ledger = buildLedger({
      inbound: priorInbound,
      outbound,
      currentInbound: turn.shopSays,
      ambiguous,
    });
    const stock = stockState(ledger);

    const verified: import("./spte/types").VerifiedExtraction = {
      found: Boolean(stub.found),
      pricePerDay: typeof stub.pricePerDay === "number" ? stub.pricePerDay : undefined,
      currency,
      declined: stub.declined === true,
      // The brush-off state (W4.3) - live reads it from the comprehension pass;
      // a frozen case pins it, exactly like `declined`.
      deflected: stub.deflected === true,
      stance: typeof stub.stance === "string" ? (stub.stance as import("./spte/types").ShopStance) : undefined,
      uncertain,
      wrongVehicle: stub.vehicleVerdict === "mismatch",
      vehicleUnclear: stub.vehicleVerdict === "unclear",
      // The identity gate's frozen verdict (Wave 3): live carries it via
      // extraction.vehicleAssessment; a case may freeze it the same way. Absent
      // on existing cases -> undefined, exactly as before.
      vehicleStatus:
        stub.vehicleStatus === "confirmed" ||
        stub.vehicleStatus === "needs-confirmation" ||
        stub.vehicleStatus === "wrong-vehicle"
          ? stub.vehicleStatus
          : undefined,
      vehicleQuestion: typeof stub.vehicleQuestion === "string" ? stub.vehicleQuestion : undefined,
      vehicleAsked: stub.vehicleAsked === true,
      askedQuestion: stub.askedQuestion === true,
      askedLocation: stub.askedLocation === true,
      askedLicense: stub.askedLicense === true,
      askedLicensePhoto: stub.askedLicensePhoto === true,
      firm: stub.firm === true,
      // OUT OF STOCK IS A STATE, read from the thread's own claims exactly as
      // live reads it (live.ts buildTurnContext -> stockState). A stub may also
      // pin it explicitly.
      shopUnavailable: stub.shopUnavailable === true || stock.state === "out-of-stock",
      restockHint: stock.restockHint,
      options,
      variance: stub.variance === true,
      hadImage: Boolean(turn.imageKind),
      imageKind: turn.imageKind as import("./spte/types").VerifiedExtraction["imageKind"],
      sheetPricePerDay:
        typeof stub.sheetPricePerDay === "number" ? stub.sheetPricePerDay : undefined,
    };

    if (verified.firm) firmSoFar++;

    // LIVE-PARITY SESSION (live.ts buildSession): the session table holds every
    // stored quote INCLUDING this shop's own from earlier turns. rivals go
    // through the same validRivals predicate (cheapest first - the replay used
    // to anchor on whichever rival was listed FIRST) and lowest through
    // sessionFloor, so the "one nudge at/below the session low, then lock" rule
    // is reachable in the gate without an explicit rival. The current turn's
    // quote is deliberately NOT in the rows - live's snapshot predates it too,
    // which is exactly why atSessionLow compares with `<=`.
    const sessionRows = [
      ...(turn.rivalOffers ?? []).map((r, i) => ({
        vendorId: r.vendorId || `rival-${i}`,
        vendorName: "Another shop",
        pricePerDay: r.pricePerDay,
        currency: r.currency,
      })),
      ...(typeof turn.rivalPricePerDay === "number"
        ? [{ vendorId: "rival", vendorName: "Another shop", pricePerDay: turn.rivalPricePerDay, currency }]
        : []),
      ...(typeof digest.quotedPricePerDay === "number"
        ? [
            {
              vendorId: "replay-shop",
              vendorName: "Golden Shop",
              pricePerDay: digest.quotedPricePerDay,
              currency,
              isThisShop: true,
            },
          ]
        : []),
    ];
    const rivals = validRivals(sessionRows, { excludeVendorId: "replay-shop", currency, limit: 4 });
    const lowest = sessionFloor(sessionRows, currency);

    const ctx: import("./spte/types").TurnContext = {
      session: {
        sessionId: "replay",
        rfq,
        currency,
        benchmark: null,
        lowest,
        rivals,
      },
      thread: {
        threadKey: "replay@wheeldeal:0000",
        vendorId: "replay-shop",
        shop: "Golden Shop",
        digest: {
          ...digest,
          options,
          // LIVE PARITY: live's buildDigest stamps THIS turn's verified quote
          // into the digest (quotedPricePerDay: input.usablePrice), and
          // dealComplete reads it - without this, a single-turn case that
          // settles price+deposit+handover could never reach `present` in the
          // gate. The prior quote is kept when this turn carries none.
          quotedPricePerDay:
            verified.found && typeof verified.pricePerDay === "number"
              ? verified.pricePerDay
              : digest.quotedPricePerDay,
          firmCount: Math.max(firmSoFar, facts.firmCount),
          // Same OR-shape as live.ts buildDigest: the ledger's typed claims
          // widen the regex facts, never narrow them.
          // Same suppression live applies (live.ts buildDigest): a deposit the
          // comprehension pass could not settle is not a known deposit.
          depositKnown:
            !ambiguous.includes("deposit") &&
            (facts.depositKnown || ledger.known.includes("deposit")),
          fulfillmentKnown: facts.fulfillmentKnown || ledger.known.includes("handover"),
          deliveryOffered: facts.deliveryOffered,
          fulfillmentCostKnown: facts.fulfillmentCostKnown,
          handoverAsks: facts.handoverAsks,
          lastOutbound: facts.lastOutbound,
          ledger,
        },
      },
      tail: [
        ...outbound.map((text) => ({ dir: "out" as const, text, at: "" })),
        { dir: "in" as const, text: turn.shopSays, at: "" },
      ],
      inbound: { text: turn.shopSays, verified },
      legalMoves: [],
      guards: {
        floorPerDay: args.floor?.floor,
        maxRounds,
        // The candidate's thresholds, placed where live places them
        // (live.ts buildTurnContext guards) - the gate validates the policy
        // that would actually ship, not the engine's outage literals.
        priceFarAboveFloor: overlay.priceFarAboveFloor,
        bannedPhrases: overlay.bannedPhrases,
      },
      event: "shop-message",
      deterministic: true,
    };

    const outcome = await runTurn(ctx);
    digest = outcome.digest;
    if (outcome.text) {
      outbound.push(outcome.text);
      outboundKinds.push(outcome.move);
    }
    played.push({
      shopSays: turn.shopSays,
      move: outcome.move,
      legalMoves: ctx.legalMoves,
      ourReply: outcome.text ?? null,
      optionCount: options.length,
      sessionLowest: lowest?.pricePerDay ?? null,
    });
  }
  return { turns: played };
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
  rivalOffers?: RivalOffer[];
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
      rivalOffers: input.rivalOffers,
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
