// The digraph execution engine - one serverless invocation per event.
//
//   sense (transcribe -> extract -> coherence -> comparator)
//     -> director (picks ONE legal edge, or waits, or stays silent)
//       -> act node composes
//         -> tail gates (style-validator -> localize -> safety -> deliver)
//
// Every step writes a trace row stamped with the node + edge ids, so the
// Pipeline Studio replays the EXACT traversed path of every real WhatsApp
// event. State checkpoints to negotiation_threads between events; strategic
// waits park a wakeup in graph_wakeups, drained opportunistically at the same
// call sites as the wa_outbox queue (no cron needed on Vercel Hobby).

import "server-only";
import { getConfig, setConfig, sbInsert, sbSelect, sbUpdate } from "../runtime-config";
import { runSafety, localizeMessage } from "../agents";
import {
  getOrchestratorConfig,
  newDecisionId,
  stripGreeting,
  validateDraft,
  writeTrace,
  type OrchestratorConfig,
  type TraceRow,
} from "../orchestrator";
import { defaultDecisionGraph, type DecisionGraph } from "../branching";
import {
  defaultGraphSpec,
  graphFromDecisionRules,
  sanitizeGraphSpec,
  validateGraphSpec,
} from "./default-graph";
import { evalGraphCondition } from "./conditions";
import { deterministicChoice, runDirector } from "./director";
import { composeForNode, computeRoundTarget } from "./nodes";
import {
  applyExtractionToState,
  dealComplete,
  depositKnown,
  derivePhase,
  fulfillmentKnown,
  loadThreadState,
  newThreadState,
  priceKnown,
  saveThreadState,
  threadKeyFor,
} from "./state";
import { validateMediaCoherence } from "./coherence";
import { enforceEmojiTone, ensureGloballyFresh } from "./uniqueness";
import type {
  DeliverResult,
  DirectorChoice,
  GraphFacts,
  GraphIO,
  GraphSpec,
  GraphTurnInput,
  LegalEdge,
  NegotiationThreadState,
  NodeSpec,
  SessionShopRow,
  WakeupRow,
} from "./types";
import { shopAskedQuestion } from "./nodes";

// ---------------------------------------------------------------------------
// Graph spec persistence (app_config key, hot-applied, legacy auto-migration)
// ---------------------------------------------------------------------------

const GRAPH_SPEC_KEY = "graph_spec";
const LEGACY_GRAPH_KEY = "decision_graph";

declare global {
  // eslint-disable-next-line no-var
  var __wd_graph_spec__: { at: number; value: GraphSpec } | undefined;
}

// Old rule id -> new default edge id (the owner's enable/order edits carry over).
const LEGACY_RULE_TO_EDGE: Record<string, string> = {
  "session-closed": "d-silent-closed",
  "answer-question": "d-answer",
  "thank-vehicle-photo": "d-thank-photo",
  "clarify-once": "d-clarify",
  "close-great-price": "d-close-great",
  "silent-great-price-closed": "d-silent-great",
  "close-no-real-saving": "d-close-no-saving",
  "silent-no-real-saving-closed": "d-silent-no-saving",
  "bargain-once": "d-bargain",
  "close-after-bargain": "d-close-after-push",
};

async function migrateFromLegacy(): Promise<GraphSpec> {
  const spec = defaultGraphSpec();
  try {
    const raw = await getConfig(LEGACY_GRAPH_KEY);
    if (!raw) return spec;
    const legacy = JSON.parse(raw) as DecisionGraph;
    if (legacy?.version !== 1 || !Array.isArray(legacy.rules)) return spec;
    const def = defaultDecisionGraph();
    const changed = JSON.stringify(legacy.rules) !== JSON.stringify(def.rules);
    if (!changed) return spec;
    // Carry the owner's edits: enabled/order per known rule; custom rules
    // become extra director edges with their original typed conditions.
    for (const rule of legacy.rules) {
      const edgeId = LEGACY_RULE_TO_EDGE[rule.id];
      if (edgeId) {
        const edge = spec.edges.find((x) => x.id === edgeId);
        if (edge) {
          edge.enabled = rule.enabled;
          edge.priority = rule.order;
          if (rule.label) edge.label = rule.label;
        }
      } else {
        spec.edges.push(...graphFromDecisionRules([rule]));
      }
    }
  } catch {
    /* keep defaults */
  }
  return spec;
}

export async function getGraphSpec(): Promise<GraphSpec> {
  const cached = globalThis.__wd_graph_spec__;
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  let spec: GraphSpec | null = null;
  try {
    const raw = await getConfig(GRAPH_SPEC_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as GraphSpec;
      if (parsed?.version === 2) spec = sanitizeGraphSpec(parsed);
    }
  } catch {
    /* fall through */
  }
  if (!spec) {
    spec = await migrateFromLegacy();
    // Persist the migrated copy so the Studio opens on the owner's real graph
    // (best-effort - defaults still serve if the write fails).
    setConfig(GRAPH_SPEC_KEY, JSON.stringify(spec)).catch(() => {});
  }
  globalThis.__wd_graph_spec__ = { at: Date.now(), value: spec };
  return spec;
}

export async function saveGraphSpec(spec: GraphSpec): Promise<{ ok: boolean; problems: string[] }> {
  const clean = sanitizeGraphSpec(spec);
  const v = validateGraphSpec(clean);
  if (!v.ok) return { ok: false, problems: v.problems };
  await setConfig(GRAPH_SPEC_KEY, JSON.stringify(clean));
  globalThis.__wd_graph_spec__ = undefined;
  return { ok: true, problems: [] };
}

/** Engine kill-switch: `GRAPH_ENGINE=off` reverts to the legacy inline loop. */
export async function graphEngineEnabled(): Promise<boolean> {
  const v = ((await getConfig("GRAPH_ENGINE")) ?? "").trim().toLowerCase();
  return v !== "off" && v !== "0" && v !== "false";
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

function buildFacts(args: {
  input: GraphTurnInput;
  state: NegotiationThreadState;
  spec: GraphSpec;
  target?: number;
  rivalPrice?: number;
  mediaCoherent: boolean;
}): GraphFacts {
  const { input, state, spec } = args;
  const f = state.fields;
  const isTick = input.event.kind === "tick";
  const price = f.pricePerDay;
  const priceOk = priceKnown(f);
  const atFloor = Boolean(
    price && input.floorPrice && price <= input.floorPrice * 1.05
  );
  const counts = {
    clarify: Math.max(input.legacyCounts.clarify, state.nodeRuns["clarify"] ?? 0),
    bargain: Math.max(
      input.legacyCounts.bargain,
      f.rounds ?? 0,
      state.nodeRuns["bargain"] ?? 0
    ),
    answer: Math.max(input.legacyCounts.answer, state.nodeRuns["answer"] ?? 0),
    close: Math.max(input.legacyCounts.close, state.nodeRuns["close"] ?? 0),
  };
  return {
    sessionClosed: input.sessionClosed,
    // A tick carries no NEW shop message - never re-answer / re-clarify on it.
    shopAskedQuestion: isTick ? false : shopAskedQuestion(input.event.shopMessage),
    shopSentVehiclePhoto: isTick ? false : input.extraction?.imageKind === "vehicle",
    hasUsablePrice: priceOk,
    verified: Boolean(f.priceVerified),
    hasClarifyMessage: isTick ? false : Boolean(input.extraction?.clarifyMessage),
    matchesSpecNotFalse: input.extraction ? input.extraction.matchesSpec !== false : true,
    priceAtOrBelowFloor: atFloor,
    targetIsRealSaving: Boolean(price && args.target && args.target < price * 0.95),
    rivalCheaper: Boolean(args.rivalPrice),
    counts,
    event: input.event.kind,
    phase: state.phase,
    priceKnown: priceOk,
    depositKnown: depositKnown(f),
    fulfillmentKnown: fulfillmentKnown(f),
    depositPassportOnly: f.depositType === "passport",
    cashAlternativeAsked: Boolean(f.cashAlternativeAsked),
    firmCount: f.firmCount ?? 0,
    rounds: f.rounds ?? 0,
    maxRounds: spec.settings.maxRoundsPerShop,
    toneDegraded: Boolean(f.toneDegraded),
    dealComplete: dealComplete(f),
    pickupOffered: Boolean(f.pickupOffered),
    pickupConsent: Boolean(f.pickupConsent),
    hasImage: input.event.images.length > 0,
    hasAudio: input.event.audios.length > 0 || Boolean(input.transcript),
    mediaCoherent: args.mediaCoherent,
    nodeRuns: state.nodeRuns,
  };
}

function legalEdgesFrom(
  spec: GraphSpec,
  fromId: string,
  facts: GraphFacts
): LegalEdge[] {
  const nodesById = new Map(spec.nodes.map((x) => [x.id, x]));
  return spec.edges
    .filter((edge) => edge.enabled && edge.from === fromId)
    .filter((edge) => {
      const node = nodesById.get(edge.to);
      if (!node || !node.enabled) return false;
      if (
        node.maxRunsPerThread != null &&
        (facts.nodeRuns[node.id] ?? 0) >= node.maxRunsPerThread
      ) {
        return false;
      }
      return evalGraphCondition(edge.when, facts);
    })
    .sort((x, y) => x.priority - y.priority)
    .map((edge) => ({
      edgeId: edge.id,
      label: edge.label ?? edge.id,
      toNodeId: edge.to,
      toKind: nodesById.get(edge.to)!.kind,
    }));
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

export interface GraphTurnResult {
  decisionId: string;
  action: string; // silent | deferred | node id that composed | ...
  message?: string;
  delivered?: DeliverResult;
  traces: TraceRow[];
}

export async function runGraphTurn(
  input: GraphTurnInput,
  io: GraphIO,
  specOverride?: GraphSpec
): Promise<GraphTurnResult> {
  const spec = specOverride ?? (await getGraphSpec());
  const cfg = await getOrchestratorConfig();
  const nodesById = new Map(spec.nodes.map((x) => [x.id, x]));
  const nodeOn = (id: string) => nodesById.get(id)?.enabled !== false && nodesById.has(id);

  const decisionId = newDecisionId();
  const traces: TraceRow[] = [];
  const base = {
    decisionId,
    userEmail: input.ctx.sender ?? undefined,
    vendorId: input.ctx.vendorId ?? undefined,
    vendorName: input.ctx.vendorName ?? undefined,
  };
  const push = (row: Omit<TraceRow, keyof typeof base>) => traces.push({ ...base, ...row });

  // LLM budget: hard cap per event + the serverless deadline.
  let llmCalls = 0;
  const llmBudget = () => {
    if (!io.llmAllowed) return false;
    if (llmCalls >= spec.settings.maxLlmCallsPerEvent) return false;
    if (input.deadlineAt - io.now() < 8_000) return false;
    llmCalls++;
    return true;
  };

  // ---- state ---------------------------------------------------------------
  let state =
    (await io.loadState(input.event.threadKey)) ??
    newThreadState({
      threadKey: input.event.threadKey,
      userEmail: input.ctx.sender,
      vendorId: input.ctx.vendorId,
      vendorName: input.ctx.vendorName,
      toNumber: input.event.toDigits,
    });
  // A fresh inbound supersedes any pending strategic wait - the shop spoke
  // again, so the "let them send the last message" bet already paid off.
  if (input.event.kind.startsWith("inbound") && state.waitingUntil) {
    state = { ...state, waitingUntil: null };
    await io.clearWakeups(state.threadKey, "tick");
  }
  state = applyExtractionToState(state, input.extraction, input.usablePrice, input.currency);
  state.lastDecisionId = decisionId;

  // ---- sense traces ----------------------------------------------------------
  if (input.transcript && nodeOn("transcribe")) {
    push({
      stage: "transcribe",
      nodeId: "transcribe",
      input: "(voice note)",
      reasoning: `heavy-accent transcription via ${input.transcript.source}${
        input.transcript.language ? ` - detected ${input.transcript.language}` : ""
      }`,
      output: input.transcript.text.slice(0, 600),
    });
  }
  if (input.extraction) {
    push({
      stage: "extract",
      nodeId: "extract",
      input: (input.event.shopMessage || "(media only)").slice(0, 600),
      reasoning: `found=${input.extraction.found} matchesSpec=${input.extraction.matchesSpec} confidence=${input.extraction.confidence}${
        input.extraction.imageKind ? ` imageKind=${input.extraction.imageKind}` : ""
      }${input.extraction.shopFirm ? " shopFirm" : ""}${
        input.extraction.shopTone === "annoyed" ? " tone=annoyed" : ""
      }`,
      output: input.usablePrice
        ? `${input.usablePrice} ${input.currency}/day`
        : "(no usable price)",
    });
  }

  // ---- media coherence -------------------------------------------------------
  let mediaCoherent = true;
  const hadMedia = input.event.images.length > 0 || Boolean(input.transcript);
  if (hadMedia && nodeOn("coherence") && input.extraction) {
    const verdict = await validateMediaCoherence({
      kind: input.transcript ? "audio" : "image",
      interpretation: input.transcript?.text ?? input.event.shopMessage ?? "(image)",
      extraction: input.extraction,
      history: input.history,
      rfq: input.rfq,
      floorPrice: input.floorPrice,
      floorTypical: input.floorTypical,
      region: input.ctx.region,
      llmAllowed: llmBudget(),
    });
    mediaCoherent = verdict.coherent;
    if (verdict.correctedPricePerDay && verdict.correctedPricePerDay > 0) {
      state = {
        ...state,
        fields: { ...state.fields, pricePerDay: verdict.correctedPricePerDay },
      };
      state.phase = derivePhase(state);
    }
    push({
      stage: "media-coherence",
      nodeId: "coherence",
      input: (input.transcript?.text ?? "(image reading)").slice(0, 400),
      reasoning: verdict.issues.join("; ") || "interpretation fits the conversation",
      output: verdict.coherent ? "coherent" : "NOT coherent - confirm in text",
      verdict: verdict.fromAi ? undefined : "deterministic",
    });
  }

  // ---- comparator (floor + rival + round target) ------------------------------
  let rivalPrice: number | undefined;
  let target: number | undefined;
  const f = state.fields;
  if (nodeOn("comparator") && priceKnown(f)) {
    const atFloor = Boolean(
      input.floorPrice && f.pricePerDay! <= input.floorPrice * 1.05
    );
    if (!atFloor && input.ctx.sender && input.ctx.vendorId) {
      const { vehicleKeyFor } = await import("../market");
      rivalPrice = await io
        .cheapestRival({
          userEmail: input.ctx.sender,
          vendorId: input.ctx.vendorId,
          currency: input.currency,
          vehicleKey: vehicleKeyFor(input.rfq),
          belowPrice: f.pricePerDay!,
        })
        .catch(() => undefined);
    }
    if (!atFloor) {
      target = computeRoundTarget({
        quoted: f.pricePerDay!,
        floorPrice: input.floorPrice,
        rivalPrice,
        rounds: f.rounds ?? 0,
        lastTarget: f.lastTarget,
      });
    }
    push({
      stage: "comparator",
      nodeId: "comparator",
      input: `quoted=${f.pricePerDay} ${input.currency} floor=${input.floorPrice ?? "?"} rounds=${f.rounds}`,
      reasoning: rivalPrice
        ? `cheapest rival in this session: ${rivalPrice} ${input.currency}/day - honest leverage`
        : atFloor
        ? "price already at/below the local floor"
        : "no cheaper rival yet",
      output: target ? `next target ${target} ${input.currency}/day` : "(no ask planned)",
    });
  }

  // ---- the director loop -------------------------------------------------------
  let facts = buildFacts({ input, state, spec, target, rivalPrice, mediaCoherent });
  let steps = 0;
  let lastResult: GraphTurnResult = { decisionId, action: "silent", traces };

  while (steps++ < spec.settings.maxStepsPerEvent) {
    const legal = legalEdgesFrom(spec, "director", facts);
    let choice: DirectorChoice;
    if (nodeOn("director")) {
      choice = await runDirector({
        input,
        state,
        facts,
        legal,
        session:
          input.ctx.sender && io.llmAllowed
            ? await io.sessionTable(input.ctx.sender, input.ctx.vendorId).catch(() => [])
            : [],
        settings: spec.settings,
        instructions: nodesById.get("director")?.instructions ?? "",
        target,
        rivalPrice,
        llmAllowed: llmBudget(),
      });
    } else {
      choice = deterministicChoice(legal, "director disabled - deterministic ladder");
    }
    push({
      stage: "director",
      nodeId: "director",
      edgeId: choice.edgeId ?? undefined,
      input:
        `event=${facts.event} phase=${facts.phase} missing=[${[
          facts.depositKnown ? "" : "deposit",
          facts.fulfillmentKnown ? "" : "fulfillment",
          facts.priceKnown ? "" : "price",
        ]
          .filter(Boolean)
          .join(",")}] legal=[${legal.map((l) => l.edgeId).join(", ") || "none"}]`,
      reasoning: choice.reasoning,
      output:
        choice.action +
        (choice.waitSeconds ? ` ${choice.waitSeconds}s` : "") +
        (choice.edgeId ? ` -> ${choice.edgeId}` : "") +
        (choice.leverageNote ? ` | leverage: ${choice.leverageNote}` : ""),
      verdict: choice.fromAi ? undefined : "deterministic",
    });

    if (choice.action === "silent" || !choice.edgeId) {
      state.phase = derivePhase(state);
      await io.saveState(state);
      await io.writeTrace(traces);
      return { ...lastResult, action: "silent" };
    }

    if (choice.action === "wait-defer") {
      const until = new Date(io.now() + (choice.waitSeconds ?? 600) * 1000).toISOString();
      state.waitingUntil = until;
      await io.insertWakeup({
        kind: "tick",
        threadKey: state.threadKey,
        notBefore: until,
        payload: { reason: choice.reasoning },
      });
      push({
        stage: "deliver",
        nodeId: "deliver",
        input: "(decision deferred)",
        reasoning: `strategic wait ${Math.round((choice.waitSeconds ?? 600) / 60)}min - ${choice.reasoning}`,
        output: `wakeup at ${until}`,
      });
      await io.saveState(state);
      await io.writeTrace(traces);
      return { ...lastResult, action: "deferred" };
    }

    const edge = spec.edges.find((x) => x.id === choice.edgeId)!;
    const node = nodesById.get(edge.to)!;

    const result = await composeForNode({
      node,
      edgeLabel: edge.label ?? edge.id,
      input,
      state,
      spec,
      cfg,
      target,
      rivalPrice,
      leverageNote: choice.leverageNote,
      llmBudget,
    });
    state.nodeRuns[node.id] = (state.nodeRuns[node.id] ?? 0) + 1;
    if (result.fieldsPatch) {
      state = { ...state, fields: { ...state.fields, ...result.fieldsPatch } };
    }
    push({
      stage: node.kind,
      nodeId: node.id,
      edgeId: edge.id,
      input: `via "${edge.label ?? edge.id}"${target ? ` target=${target} ${input.currency}` : ""}${
        rivalPrice ? ` rival=${rivalPrice}` : ""
      }`,
      reasoning: result.reasoning,
      output: result.message ?? "(state move - no message)",
      verdict: result.verdict,
    });

    if (node.kind === "present") {
      await io
        .markPresentable({
          userEmail: input.ctx.sender,
          vendorId: input.ctx.vendorId,
          fulfillment: state.fields.fulfillment ?? null,
        })
        .catch(() => {});
      state.phase = derivePhase(state);
      // present loops back to the director (t-present-back) for a warm close.
      facts = buildFacts({ input, state, spec, target, rivalPrice, mediaCoherent });
      lastResult = { decisionId, action: "present", traces };
      continue;
    }

    if (result.terminal || !result.message) {
      state.phase = derivePhase(state);
      await io.saveState(state);
      await io.writeTrace(traces);
      return { decisionId, action: node.id, traces };
    }

    // ---- tail gates ----------------------------------------------------------
    const delivered = await runTailGates({
      draft: result.message,
      englishGloss: result.englishGloss,
      kind: result.kind ?? `auto-${node.id}`,
      nodeId: node.id,
      tacticId: result.tacticId,
      nextRound: result.nextRound ?? input.ctx.round ?? 0,
      holdSeconds: choice.action === "wait-hold" ? choice.waitSeconds : undefined,
      input,
      io,
      spec,
      cfg,
      nodeOn,
      push,
      llmBudget,
      decisionId,
    });

    if (node.kind === "bargain" && result.tacticId && delivered.delivered !== "blocked") {
      await io
        .insertBargainDraft({
          userEmail: input.ctx.sender,
          vendorId: input.ctx.vendorId,
          tactic: result.tacticId,
          message: result.message,
        })
        .catch(() => {});
    }
    if (node.kind === "closing-message" && delivered.delivered !== "blocked") {
      state.phase = "closing";
    }

    state.phase = derivePhase(state);
    await io.saveState(state);
    await io.writeTrace(traces);
    return {
      decisionId,
      action: node.id,
      message: delivered.finalText ?? result.message,
      delivered,
      traces,
    };
  }

  // Step budget exhausted - trace it and go quiet (never a loud failure).
  push({
    stage: "deliver",
    nodeId: "deliver",
    input: "(traversal cap)",
    reasoning: `stopped after ${spec.settings.maxStepsPerEvent} steps - graph may have a loop`,
    output: "silent",
  });
  await io.saveState(state);
  await io.writeTrace(traces);
  return { decisionId, action: "silent", traces };
}

// ---------------------------------------------------------------------------
// Tail gates: style-validator -> localize -> safety -> deliver
// ---------------------------------------------------------------------------

async function runTailGates(args: {
  draft: string;
  englishGloss?: string;
  kind: string;
  nodeId: string;
  tacticId?: string;
  nextRound: number;
  holdSeconds?: number;
  input: GraphTurnInput;
  io: GraphIO;
  spec: GraphSpec;
  cfg: OrchestratorConfig;
  nodeOn: (id: string) => boolean;
  push: (row: Omit<TraceRow, "decisionId" | "userEmail" | "vendorId" | "vendorName">) => void;
  llmBudget: () => boolean;
  decisionId: string;
}): Promise<DeliverResult> {
  const { input, io, spec, cfg, nodeOn, push } = args;
  let text = args.draft;
  let englishGloss = args.englishGloss;
  const useLocalLang = Boolean(input.ctx.localLang) && input.ctx.plan === "ultra";
  const isLocalizedBargain = args.nodeId === "bargain" && useLocalLang;

  // ---- style-validator -------------------------------------------------------
  if (nodeOn("style-validator")) {
    if (input.priorOutbound.length > 0) text = stripGreeting(text);
    // Localized bargains skip the AI critique (an English pass on Thai text
    // risks flipping the language - stickiness wins), deterministic still runs.
    const validation = await validateDraft({
      cfg:
        isLocalizedBargain || !args.llmBudget()
          ? {
              ...cfg,
              stages: cfg.stages.map((s) =>
                s.id === "validator" ? { ...s, enabled: false } : s
              ),
            }
          : cfg,
      history: input.history,
      draft: text,
      shopMessage: input.event.shopMessage,
      priorOutbound: input.priorOutbound,
      currency: input.currency,
    });
    if (validation.verdict === "veto" || !validation.text) {
      push({
        stage: "style-validator",
        nodeId: "style-validator",
        input: text,
        reasoning: validation.reasons.join("; ") || "vetoed",
        output: "(vetoed)",
        verdict: "veto",
      });
      return { delivered: "blocked", detail: "vetoed by the style validator" };
    }
    text = validation.text;
    // Global uniqueness (hundreds of users must never repeat a sentence) +
    // the warm-emoji tone policy. Skipped for local-language output - the
    // trigram store is English and an emoji swap there is safe anyway.
    let freshNote = "";
    if (!isLocalizedBargain) {
      const recent = await io.recentOutboundGlobal(6, 200).catch(() => []);
      const fresh = ensureGloballyFresh(text, recent);
      if (fresh.changed) {
        freshNote = ` re-varied (overlap ${(fresh.maxOverlap * 100).toFixed(0)}%)`;
      }
      text = enforceEmojiTone(fresh.text, spec.settings.emojiTone);
    }
    push({
      stage: "style-validator",
      nodeId: "style-validator",
      input: args.draft,
      reasoning: (validation.reasons.join("; ") || "clean") + freshNote,
      output: text,
      verdict: validation.verdict === "ok" && !freshNote ? "ok" : "revised",
    });
  }

  // ---- localize ----------------------------------------------------------------
  if (nodeOn("localize") && useLocalLang && args.nodeId !== "bargain") {
    const localized = await localizeMessage(
      text,
      input.ctx.region || undefined,
      input.ctx.sender,
      spec.settings.streetLocal
    );
    if (localized.text && localized.text !== text) {
      englishGloss = localized.english ?? text;
      push({
        stage: "localize",
        nodeId: "localize",
        input: text,
        reasoning: "thread language stickiness - native local rewrite",
        output: localized.text,
      });
      text = localized.text;
    }
  }

  // ---- safety --------------------------------------------------------------------
  if (nodeOn("safety")) {
    const verdict = await runSafety(text);
    if (!verdict.allowed) {
      push({
        stage: "safety",
        nodeId: "safety",
        input: text,
        reasoning: verdict.reason ?? "blocked by the safety screen",
        output: "(blocked)",
        verdict: "veto",
      });
      return { delivered: "blocked", detail: verdict.reason ?? "safety block" };
    }
  }

  // ---- deliver --------------------------------------------------------------------
  const meta = {
    ...input.ctx,
    kind: args.kind,
    round: args.nextRound,
    auto: true,
    nodeId: args.nodeId,
    decisionId: args.decisionId,
    ...(englishGloss ? { englishGloss } : {}),
  };
  let delivered: DeliverResult;
  if (input.humanDelay && input.ctx.sender) {
    // Human thinking time (instant replies are THE robotic tell). The director
    // hold extends it - patience is a deliberate tactic.
    const jitter =
      args.kind === "auto-close" || args.kind === "auto-answer"
        ? 20 + Math.floor(Math.random() * 70) // 20-90s
        : args.kind === "auto-deposit-probe" || args.kind === "auto-fulfillment-probe"
        ? 30 + Math.floor(Math.random() * 120) // 30-150s
        : args.kind === "deal-close" || args.kind === "auto-pickup-location"
        ? 8 + Math.floor(Math.random() * 30) // the traveller just acted - quick is natural
        : 45 + Math.floor(Math.random() * 195); // bargains "think" 45-240s
    const delayS = args.holdSeconds ?? jitter;
    await io.queueOutbox({
      senderKey: input.ctx.sender,
      toNumber: input.event.toDigits,
      body: text,
      notBeforeMs: io.now() + delayS * 1000,
      meta: {
        ...meta,
        reason: args.holdSeconds
          ? "director hold - choosing the best reply order"
          : "human reply pacing (thinking time)",
      },
    });
    delivered = {
      delivered: "queued",
      detail: args.holdSeconds ? `director hold ${delayS}s` : `human pacing ${delayS}s`,
      finalText: text,
      queuedUntil: new Date(io.now() + delayS * 1000).toISOString(),
    };
  } else {
    delivered = await io.guardAndSend({
      senderKey: input.ctx.sender ?? "system",
      toNumber: input.event.toDigits,
      text,
      meta,
    });
  }
  push({
    stage: "deliver",
    nodeId: "deliver",
    input: text,
    reasoning: delivered.detail,
    output:
      delivered.delivered === "sent"
        ? delivered.finalText ?? text
        : `(${delivered.delivered}${delivered.queuedUntil ? ` until ${delivered.queuedUntil}` : ""})`,
  });

  // ---- judge enqueue (never inline - a cheap later invocation grades it) ------
  if (
    delivered.delivered !== "blocked" &&
    Math.random() < spec.settings.judgeSampleRate &&
    args.kind !== "deal-close"
  ) {
    await io
      .insertWakeup({
        kind: "judge",
        threadKey: input.event.threadKey,
        notBefore: new Date(io.now() + 90_000).toISOString(),
        payload: {
          decisionId: args.decisionId,
          nodeId: args.nodeId,
          tacticId: args.tacticId,
          text,
          kind: args.kind,
          userEmail: input.ctx.sender,
          vendorId: input.ctx.vendorId,
          vendorName: input.ctx.vendorName,
        },
      })
      .catch(() => {});
  }
  return delivered;
}

// ---------------------------------------------------------------------------
// Live IO
// ---------------------------------------------------------------------------

export type LiveSend = (
  senderKey: string,
  to: string,
  text: string
) => Promise<{ ok: boolean; error?: string }>;

export function liveGraphIO(send: LiveSend): GraphIO {
  return {
    loadState: loadThreadState,
    saveState: saveThreadState,
    async cheapestRival({ userEmail, vendorId, currency, vehicleKey, belowPrice }) {
      const since = new Date(Date.now() - 18 * 3600_000).toISOString();
      const rivals = await sbSelect<{ price_per_day: number }>(
        "offers",
        `select=price_per_day&user_email=eq.${encodeURIComponent(
          userEmail
        )}&simulated=eq.false&currency=eq.${encodeURIComponent(
          currency
        )}&vehicle_key=eq.${encodeURIComponent(vehicleKey)}&vendor_id=neq.${encodeURIComponent(
          vendorId
        )}&price_per_day=lt.${belowPrice}&created_at=gte.${encodeURIComponent(
          since
        )}&order=price_per_day.asc&limit=1`
      );
      return rivals[0]?.price_per_day;
    },
    async sessionTable(userEmail, thisVendorId) {
      const since = new Date(Date.now() - 18 * 3600_000).toISOString();
      const offers = await sbSelect<{
        vendor_id: string;
        vendor_name: string;
        price_per_day: number;
        currency: string;
      }>(
        "offers",
        `select=vendor_id,vendor_name,price_per_day,currency&user_email=eq.${encodeURIComponent(
          userEmail
        )}&simulated=eq.false&created_at=gte.${encodeURIComponent(
          since
        )}&order=created_at.desc&limit=16`
      ).catch(() => []);
      const threads = await sbSelect<{
        vendor_id: string | null;
        vendor_name: string | null;
        phase: string;
        fields: Record<string, unknown> | null;
      }>(
        "negotiation_threads",
        `select=vendor_id,vendor_name,phase,fields&user_email=eq.${encodeURIComponent(
          userEmail
        )}&updated_at=gte.${encodeURIComponent(since)}&limit=16`
      ).catch(() => []);
      const rows = new Map<string, SessionShopRow>();
      for (const t of threads) {
        if (!t.vendor_id) continue;
        const fx = (t.fields ?? {}) as {
          pricePerDay?: number;
          currency?: string;
          depositType?: string;
          depositNote?: string;
          fulfillment?: string;
        };
        rows.set(t.vendor_id, {
          vendorId: t.vendor_id,
          vendorName: t.vendor_name ?? t.vendor_id,
          pricePerDay: fx.pricePerDay,
          currency: fx.currency,
          phase: t.phase as SessionShopRow["phase"],
          complete: Boolean(
            fx.pricePerDay && (fx.depositType || fx.depositNote) && fx.fulfillment
          ),
          isThisShop: t.vendor_id === thisVendorId,
        });
      }
      for (const o of offers) {
        if (rows.has(o.vendor_id)) continue;
        rows.set(o.vendor_id, {
          vendorId: o.vendor_id,
          vendorName: o.vendor_name || o.vendor_id,
          pricePerDay: o.price_per_day,
          currency: o.currency,
          isThisShop: o.vendor_id === thisVendorId,
        });
      }
      return [...rows.values()].slice(0, 10);
    },
    async insertWakeup(row: WakeupRow) {
      await sbInsert("graph_wakeups", [
        {
          kind: row.kind,
          thread_key: row.threadKey,
          not_before: row.notBefore,
          payload: row.payload ?? null,
        },
      ]);
    },
    async clearWakeups(threadKey, kind) {
      const { sbDeleteReturning } = await import("../runtime-config");
      await sbDeleteReturning(
        "graph_wakeups",
        `thread_key=eq.${encodeURIComponent(threadKey)}${kind ? `&kind=eq.${kind}` : ""}`
      ).catch(() => {});
    },
    async queueOutbox({ senderKey, toNumber, body, notBeforeMs, meta }) {
      await sbInsert("wa_outbox", [
        {
          sender_key: senderKey,
          to_number: toNumber,
          body,
          not_before: new Date(notBeforeMs).toISOString(),
          meta,
        },
      ]);
    },
    async guardAndSend({ senderKey, toNumber, text, meta }) {
      const { guardOutbound, afterSend } = await import("../wa-guard");
      const verdict = await guardOutbound({
        senderKey,
        toDigits: toNumber,
        text,
        auto: true,
        queueIfBlocked: true,
        meta,
      });
      if (!verdict.allow) {
        return {
          delivered: verdict.queuedUntil ? "queued" : "held",
          detail: verdict.reason ?? "held by the anti-ban gate",
          queuedUntil: verdict.queuedUntil,
          finalText: verdict.text,
        };
      }
      const result = await send(senderKey, toNumber, verdict.text);
      if (result.ok) {
        await afterSend(senderKey, toNumber);
        await sbInsert("whatsapp_messages", [
          {
            to_number: toNumber,
            body: verdict.text,
            type: "text",
            direction: "outbound",
            raw: { ...meta, sender: senderKey },
          },
        ]);
        return { delivered: "sent", detail: "sent through the user's WhatsApp", finalText: verdict.text };
      }
      return { delivered: "failed", detail: `send failed: ${result.error ?? "unknown"}`, finalText: verdict.text };
    },
    async markPresentable({ userEmail, vendorId, fulfillment }) {
      if (!vendorId) return;
      const rows = await sbSelect<{ id: number }>(
        "offers",
        `select=id&vendor_id=eq.${encodeURIComponent(vendorId)}${
          userEmail ? `&user_email=eq.${encodeURIComponent(userEmail)}` : ""
        }&simulated=eq.false&order=created_at.desc&limit=1`
      ).catch(() => []);
      if (!rows[0]?.id) return;
      await sbUpdate("offers", `id=eq.${rows[0].id}`, {
        presentable: true,
        ...(fulfillment ? { fulfillment } : {}),
      }).catch(() => {});
    },
    async insertBargainDraft({ userEmail, vendorId, tactic, message }) {
      await sbInsert("bargain_drafts", [
        {
          user_email: userEmail ?? null,
          vendor_id: vendorId ?? "",
          tactic,
          message,
        },
      ]);
    },
    async recentOutboundGlobal(hours, limit) {
      const since = new Date(Date.now() - hours * 3600_000).toISOString();
      const rows = await sbSelect<{ body: string | null }>(
        "whatsapp_messages",
        `select=body&direction=eq.outbound&received_at=gte.${encodeURIComponent(
          since
        )}&order=received_at.desc&limit=${Math.min(500, limit)}`
      );
      return rows.map((r) => r.body ?? "").filter(Boolean);
    },
    writeTrace,
    llmAllowed: true,
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Wakeup drain - the strategic-wait engine (mirrors drainOutbox)
// ---------------------------------------------------------------------------

interface WakeupRowDb {
  id: number;
  kind: string;
  thread_key: string;
  not_before: string;
  payload: Record<string, unknown> | null;
}

/**
 * Claim and run every due wakeup. Called opportunistically wherever
 * drainOutbox already runs (webhook, wa/status 3s poll, replies 15s poll,
 * queue, ping) - zero new infrastructure, Hobby-tier friendly. Atomic
 * delete-returning claims mean a wakeup runs exactly once even when several
 * drainers race.
 */
export async function drainGraphWakeups(send: LiveSend): Promise<number> {
  let ran = 0;
  try {
    const due = await sbSelect<WakeupRowDb>(
      "graph_wakeups",
      `select=id,kind,thread_key,not_before,payload&not_before=lte.${encodeURIComponent(
        new Date().toISOString()
      )}&order=not_before.asc&limit=5`
    );
    if (due.length === 0) return 0;
    const { sbDeleteReturning } = await import("../runtime-config");
    for (const cand of due) {
      const claimed = await sbDeleteReturning<WakeupRowDb>(
        "graph_wakeups",
        `id=eq.${cand.id}`
      );
      if (claimed.length === 0) continue; // another drainer won this row
      const row = claimed[0];
      try {
        if (row.kind === "tick") {
          const input = await buildTurnFromThread(row.thread_key, "tick");
          if (input) {
            await runGraphTurn(input, liveGraphIO(send));
            ran++;
          }
        } else if (row.kind === "judge" || row.kind === "session-judge") {
          const { runJudgeJob } = await import("./judge");
          await runJudgeJob(row.kind, row.thread_key, row.payload ?? {});
          ran++;
        }
      } catch {
        /* one bad wakeup never blocks the rest */
      }
    }
  } catch {
    /* table missing / Supabase unset - nothing to drain */
  }
  return ran;
}

// ---------------------------------------------------------------------------
// Rebuilding a turn from a stored thread (ticks + user actions)
// ---------------------------------------------------------------------------

interface StoredMsg {
  direction: "inbound" | "outbound";
  body: string | null;
  raw: Record<string, unknown> | null;
  received_at: string;
  from_number?: string | null;
  to_number?: string | null;
}

export async function buildTurnFromThread(
  threadKey: string,
  kind: "tick" | "user-consent-pickup" | "user-close-deal",
  payload?: Record<string, unknown>
): Promise<GraphTurnInput | null> {
  const idx = threadKey.lastIndexOf(":");
  if (idx <= 0) return null;
  const userEmail = threadKey.slice(0, idx);
  const toDigits = threadKey.slice(idx + 1);

  const prior = await sbSelect<StoredMsg>(
    "whatsapp_messages",
    `select=direction,body,raw,received_at&direction=eq.outbound&to_number=eq.${encodeURIComponent(
      toDigits
    )}&raw->>sender=eq.${encodeURIComponent(userEmail)}&order=received_at.desc&limit=1`
  );
  const ctx = (prior[0]?.raw ?? null) as GraphTurnInput["ctx"] & {
    rfq?: import("../types").StructuredRFQ | null;
  };
  if (!ctx?.rfq) return null;

  // Session lifecycle: the same closed-session guard the live loop uses.
  let sessionClosed = false;
  if (ctx.sender && prior[0]?.received_at) {
    const marker = await sbSelect<{ received_at: string }>(
      "whatsapp_messages",
      `select=received_at&to_number=eq.session&raw->>sender=eq.${encodeURIComponent(
        ctx.sender
      )}&raw->>kind=eq.session-closed&order=received_at.desc&limit=1`
    ).catch(() => []);
    sessionClosed = Boolean(marker[0] && marker[0].received_at > prior[0].received_at);
  }

  const threadRows = await sbSelect<StoredMsg>(
    "whatsapp_messages",
    `select=direction,body,raw,received_at&or=(to_number.eq.${encodeURIComponent(
      toDigits
    )},from_number.eq.${encodeURIComponent(toDigits)})&order=received_at.desc&limit=20`
  );
  const mine = threadRows.filter(
    (m) =>
      m.direction === "inbound" ||
      (m.raw as { sender?: string } | null)?.sender === userEmail
  );
  const thread = mine.slice(0, 12).reverse();
  const history = thread
    .map((m) => `${m.direction === "outbound" ? "Us" : "Shop"}: ${(m.body ?? "").slice(0, 300)}`)
    .join("\n");
  const priorOutbound = thread
    .filter((m) => m.direction === "outbound")
    .map((m) => m.body ?? "")
    .filter(Boolean);
  const lastInbound = [...thread].reverse().find((m) => m.direction === "inbound");
  const countKind = (k: string) =>
    thread.filter(
      (m) => m.direction === "outbound" && (m.raw as { kind?: string } | null)?.kind === k
    ).length;

  const rfq = ctx.rfq;
  const { floorPriceFor } = await import("../market");
  const { currencyForRegion } = await import("../agents");
  const cur = currencyForRegion(ctx.region || undefined) || "USD";
  const floor = await floorPriceFor(ctx.region || undefined, rfq).catch(() => null);
  const floorSameCur = floor && floor.currency === cur ? floor : null;

  return {
    event: {
      kind,
      threadKey,
      userEmail,
      toDigits,
      shopMessage: lastInbound?.body ?? "",
      images: [],
      audios: [],
      payload,
    },
    ctx,
    rfq,
    extraction: null, // no NEW inbound information on a tick/user action
    usablePrice: undefined,
    currency: cur,
    floorPrice: floorSameCur?.floor,
    floorTypical: floorSameCur?.typical ?? undefined,
    sessionClosed,
    history,
    priorOutbound,
    legacyCounts: {
      clarify: countKind("auto-clarify"),
      bargain: countKind("auto-bargain") + countKind("bargain"),
      answer: countKind("auto-answer"),
      close: countKind("auto-close"),
    },
    humanDelay: true,
    transcript: null,
    deadlineAt: Date.now() + 40_000,
  };
}

/** Entry point for user actions from the app (consent / close-deal). */
export async function runUserAction(args: {
  userEmail: string;
  toDigits: string;
  kind: "user-consent-pickup" | "user-close-deal";
  payload: Record<string, unknown>;
  send: LiveSend;
}): Promise<GraphTurnResult | null> {
  const threadKey = threadKeyFor(args.userEmail, args.toDigits);
  const input = await buildTurnFromThread(threadKey, args.kind, args.payload);
  if (!input) return null;
  // User actions send promptly - the traveller is watching the screen.
  input.humanDelay = false;
  return runGraphTurn(input, liveGraphIO(args.send));
}
