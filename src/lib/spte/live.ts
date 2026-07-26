// SPTE LIVE GLUE - the production wiring that runs the Single-Pass Turn Engine
// on a real inbound WhatsApp turn, reusing the graph engine's hardened IO
// (guardAndSend / queueOutbox / insertWakeup / sessionTable). This is the bridge
// the blueprint called for: the graph engine's runGraphTurn and this share the
// SAME GraphTurnInput + GraphIO, so processVendorReply can try V3 first and fall
// back to the graph engine on ANY error with zero behavioural drift.
//
// ROBUSTNESS CONTRACT (the reason a fallback can never double-send):
//   - Everything that can throw runs BEFORE the send decision (context build).
//   - Once runTurn has decided the move, this function OWNS the turn and never
//     throws again - the send, wakeups and telemetry are all best-effort. So a
//     throw only ever escapes before a message leaves, and the caller's fallback
//     to the graph engine is always safe.

import type { GraphIO, GraphTurnInput } from "../graph/types";
import { runTurn } from "./orchestrator";
import { emptyDigest } from "./digest";
import { deriveThreadFacts } from "./thread-facts";
import type { MoveKind, SessionSnapshot, ThreadDigest, TurnContext, VerifiedExtraction } from "./types";
import { shopAskedLocation, shopAskedLicense, shopAskedLicensePhoto } from "../wa/detectors";
import { shopAskedQuestion } from "../graph/nodes";
import { vehicleKeyFor, groundedBenchmarkFor } from "../market";

export interface SpteLiveResult {
  ran: true;
  move: MoveKind;
  tier: "R" | "F" | "M";
  provider?: string;
  delivered: "sent" | "queued" | "held" | "blocked" | "failed" | "silent";
  text?: string;
}

/** Map the graph engine's ExtractedOffer + resolved price into the SPTE verified
 *  signal set. Numbers come ONLY from the deterministic extractor (never the
 *  LLM), exactly as the blueprint requires. */
function mapVerified(input: GraphTurnInput): VerifiedExtraction {
  const ex = input.extraction;
  const text = input.event.kind === "inbound-text" || input.event.kind === "inbound-image"
    ? input.event.shopMessage ?? ""
    : "";
  return {
    found: Boolean(input.usablePrice),
    pricePerDay: input.usablePrice,
    currency: input.currency,
    declined: Boolean(ex?.shopDeclined),
    wrongVehicle: ex?.matchesSpec === false,
    outOfStock: Boolean((ex as { outOfStock?: boolean } | null)?.outOfStock),
    askedLocation: text ? shopAskedLocation(text) : false,
    askedQuestion: text ? shopAskedQuestion(text) : false,
    askedLicense: text ? shopAskedLicense(text) : false,
    askedLicensePhoto: text ? shopAskedLicensePhoto(text) : false,
    // The shop refused to lower ("last price") - the deterministic extractor
    // read it (agents.ts FIRM_RX) and it USED to be dropped on the floor here.
    firm: Boolean((ex as { shopFirm?: boolean } | null)?.shopFirm),
  };
}

/** Reconstruct the thread digest STATELESSLY from durable data we already hold
 *  (round count, the shop's current quote, tone). No new persistence layer -> no
 *  stale-digest traps; the round and quote are the only durable memory the
 *  single pass needs, and they are always recomputed from the source of truth. */
function buildDigest(input: GraphTurnInput): ThreadDigest {
  const base = emptyDigest();
  const tone = ((): ThreadDigest["tone"] => {
    const t = (input.extraction as { shopTone?: string } | null)?.shopTone;
    if (t === "annoyed") return "reluctant";
    if (t === "warm") return "friendly";
    return undefined;
  })();
  // THREAD-DERIVED STATE (thread-facts.ts): round / firm / deposit / fulfillment
  // recomputed from the actual message history the caller loaded, so the round
  // cap and the two-firms-stop rule finally bind. The current inbound firm read
  // (from the extractor) is OR-ed in so "last price" counts on the turn it lands.
  const inbound = input.priorInbound ?? [];
  const outbound = input.priorOutbound ?? [];
  const curInbound =
    input.event.kind === "inbound-text" || input.event.kind === "inbound-image"
      ? input.event.shopMessage ?? ""
      : "";
  const facts = deriveThreadFacts({
    inbound,
    outbound,
    currentInbound: curInbound,
    priorBargainCount: input.legacyCounts?.bargain ?? 0,
  });
  // The deterministic extractor may flag firmness (shopFirm) on wording the
  // text regex misses; ensure at least 1 when it did.
  const curFirm = Boolean((input.extraction as { shopFirm?: boolean } | null)?.shopFirm);
  const firmCount = curFirm ? Math.max(facts.firmCount, 1) : facts.firmCount;
  return {
    ...base,
    round: facts.bargainRounds,
    quotedPricePerDay: input.usablePrice,
    tone,
    firmCount,
    depositKnown: facts.depositKnown,
    fulfillmentKnown: facts.fulfillmentKnown,
    lastOutbound: facts.lastOutbound,
  };
}

/** Build the session snapshot (blackboard read) from the shared session table:
 *  rivals = other shops' live quotes in the SAME currency; lowest = the session's
 *  cheapest quote across all shops. Best-effort - a read failure yields an empty
 *  snapshot (the single pass still composes a safe move, never invents a rival). */
async function buildSession(input: GraphTurnInput, io: GraphIO): Promise<SessionSnapshot> {
  const email = input.ctx.sender ?? "";
  const thisVendor = input.ctx.vendorId ?? "";
  let rivals: SessionSnapshot["rivals"] = [];
  let lowest: SessionSnapshot["lowest"] = null;
  if (email) {
    const rows = await io.sessionTable(email, thisVendor).catch(() => []);
    for (const r of rows) {
      if (typeof r.pricePerDay !== "number" || !r.currency) continue;
      if (r.currency !== input.currency) continue;
      if (!lowest || r.pricePerDay < lowest.pricePerDay) {
        lowest = { vendorId: r.vendorId, shop: r.vendorName, pricePerDay: r.pricePerDay };
      }
      if (r.vendorId !== thisVendor) {
        rivals.push({ vendorId: r.vendorId, shop: r.vendorName, pricePerDay: r.pricePerDay, currency: r.currency });
      }
    }
    // Keep the cheapest few rivals - the leverage that matters.
    rivals = rivals.sort((a, b) => a.pricePerDay - b.pricePerDay).slice(0, 4);
  }
  // Grounded market benchmark (F5): the ONLY market rate allowed into the
  // prompt - web-grounded with a source URL, and ONLY when its currency matches
  // this session (never cross-currency). Best-effort; null when none exists yet.
  let benchmark: SessionSnapshot["benchmark"] = null;
  try {
    const gb = await groundedBenchmarkFor(input.ctx.region || undefined, input.rfq);
    if (gb && gb.currency === input.currency) benchmark = gb;
  } catch {
    /* no grounded benchmark -> the pass refuses to invent one */
  }
  // Few-shot coaching (owner teaching + Ops learning + distilled winning
  // traces) - the primary engine now learns like the graph engine does.
  // Best-effort; "" when nothing has been taught/distilled yet.
  const { loadCoaching } = await import("./coaching");
  const coaching = await loadCoaching().catch(() => "");
  return {
    sessionId: input.event.threadKey,
    rfq: input.rfq,
    currency: input.currency,
    benchmark,
    lowest,
    rivals,
    priors: null,
    coaching,
  };
}

function buildTail(input: GraphTurnInput): TurnContext["tail"] {
  const at = new Date(input.deadlineAt - 40_000).toISOString();
  const out = (input.priorOutbound ?? []).slice(-3).map((text) => ({ dir: "out" as const, text, at }));
  return out;
}

/** Map a closed MoveKind to the outbox meta.kind used by drain/pacing AND by the
 *  round/answer counters in agent-loop. A bargain MUST stamp "auto-bargain" or
 *  the round cap never binds (the 4-pushes-to-one-shop bug); an answer stamps
 *  "auto-answer". None of these are the cold "rfq" kind, so reply-lane pacing is
 *  preserved (only "rfq" is a cold intro). */
function metaKindFor(move: MoveKind): string {
  switch (move) {
    case "bargain":
      return "auto-bargain";
    case "clarify":
      return "auto-clarify";
    case "answer":
    case "deposit-probe":
    case "fulfillment-probe":
    case "pickup-location":
      return "auto-answer";
    case "close":
    case "closing-message":
    case "redirect-close":
      return "auto-close";
    default:
      return "reply";
  }
}

async function buildTurnContext(input: GraphTurnInput, io: GraphIO): Promise<TurnContext> {
  const session = await buildSession(input, io);
  const text = input.event.kind === "inbound-text" || input.event.kind === "inbound-image"
    ? input.event.shopMessage ?? ""
    : "";
  return {
    session,
    thread: {
      threadKey: input.event.threadKey,
      vendorId: input.ctx.vendorId ?? "",
      shop: input.ctx.vendorName ?? input.ctx.vendorId ?? "shop",
      digest: buildDigest(input),
    },
    tail: buildTail(input),
    inbound: { text, verified: mapVerified(input) },
    legalMoves: [], // computed deterministically inside runTurn (legalMovesFor)
    guards: { floorPerDay: input.floorPrice, maxRounds: 6 },
    event: input.event.kind === "tick" ? "tick" : "shop-message",
  };
}

/**
 * Run ONE live SPTE turn. Throws ONLY from the pre-send context build (so the
 * caller's graph-engine fallback is always safe). After runTurn decides the
 * move, the send + wakeups + telemetry are best-effort and never throw.
 */
export async function runSpteLiveTurn(input: GraphTurnInput, io: GraphIO): Promise<SpteLiveResult> {
  // Turn wall-clock, stamped on the telemetry event -> the response-latency KPI.
  const startedAt = Date.now();
  // ---- pre-send (fallible): build the blackboard context + run the pass ------
  const tc = await buildTurnContext(input, io);
  const outcome = await runTurn(tc); // never throws, never silent on a composable move

  // ---- from here we OWN the turn: never throw (would risk a double send) -----
  const senderKey = input.ctx.sender ?? "system";
  const toNumber = input.event.toDigits;
  const meta: Record<string, unknown> = {
    kind: metaKindFor(outcome.move),
    vendorId: input.ctx.vendorId,
    vendorName: input.ctx.vendorName,
    engine: "v3",
    move: outcome.move,
    tacticId: outcome.move,
  };

  let delivered: SpteLiveResult["delivered"] = "silent";
  const send = outcome.text && outcome.move !== "silent" ? outcome.text : undefined;

  if (send) {
    try {
      // INLINE DELIVERY (the "agent never replies" structural fix): the reply
      // leaves in the SAME serverless invocation that received the shop's
      // message. The old path parked it 18-45s out and depended on a later
      // drain invocation + a live Evolution host - which in live testing left
      // replies stuck as "queued". Now: a bounded human thinking pause (never
      // blowing the serverless budget), then guardAndSend directly - the guard
      // still paces per-recipient, and on a guard block or transient send
      // failure guardAndSend itself queues/re-queues, so nothing is lost.
      if (input.humanDelay) {
        const remaining = input.deadlineAt - io.now();
        const pauseMs = Math.max(0, Math.min(10_000, remaining - 20_000));
        if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
      }
      const res = await io.guardAndSend({ senderKey, toNumber, text: send, meta, shopOpenNow: input.shopOpenNow });
      delivered = res.delivered;
    } catch {
      // Post-decision send failure: park it so the drain retries, never re-run
      // the whole turn (that path belongs to the pre-send fallback only).
      try {
        await io.queueOutbox({
          senderKey,
          toNumber,
          body: send,
          notBeforeMs: io.now() + 30_000,
          meta: { ...meta, reason: "reply re-queued after send error" },
        });
        delivered = "queued";
      } catch {
        delivered = "failed";
      }
    }
  }

  // Strategic wait (deliberate patience) -> a wakeup re-enters this thread later.
  if (outcome.waitMinutes && outcome.waitMinutes > 0) {
    await io
      .insertWakeup({
        kind: "tick",
        threadKey: input.event.threadKey,
        notBefore: new Date(io.now() + outcome.waitMinutes * 60_000).toISOString(),
        payload: { userEmail: input.ctx.sender, vendorId: input.ctx.vendorId, engine: "v3" },
      })
      .catch(() => {});
  }

  // TRANSPARENCY telemetry (feeds the Session Blackboard Inspector): the exact
  // move, model tier/provider, the private scratchpad, and the wire text.
  await io
    .recordEvent?.({
      kind: "engine-v3-turn",
      vendorId: input.ctx.vendorId,
      vendorName: input.ctx.vendorName,
      detail: JSON.stringify({
        move: outcome.move,
        tier: outcome.route.tier,
        provider: outcome.route.provider ?? null,
        reason: outcome.route.reason,
        think: outcome.artifact.think?.slice(0, 200),
        legalMoves: tc.legalMoves,
        floor: input.floorPrice ?? null,
        lowest: tc.session.lowest?.pricePerDay ?? null,
        rivals: tc.session.rivals.length,
        quote: input.usablePrice ?? null,
        materialDrop: outcome.materialDrop,
        delivered,
        // Response latency (ms) for this turn - feeds the p50/p95 KPI. Only a
        // real reply that actually went out is a meaningful latency sample.
        latencyMs: delivered === "sent" ? Date.now() - startedAt : null,
        text: send?.slice(0, 200) ?? null,
        vehicleKey: vehicleKeyFor(input.rfq),
      }).slice(0, 1400),
    })
    .catch(() => {});

  return {
    ran: true,
    move: outcome.move,
    tier: outcome.route.tier,
    provider: outcome.route.provider,
    delivered,
    text: send,
  };
}
