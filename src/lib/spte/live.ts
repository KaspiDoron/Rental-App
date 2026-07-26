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
import { clampWaitMinutes } from "./wait";
import { optionsFromThread, signalsVariance } from "../offer-options";
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
    // ONLY a positively-named different class ends a thread. "unclear" (a bare
    // price, a menu, a question back) used to land here as wrongVehicle and made
    // `redirect-close` the single legal move - a goodbye to a shop that was
    // still talking to us.
    wrongVehicle: ex?.vehicleVerdict === "mismatch" || (!ex?.vehicleVerdict && ex?.matchesSpec === false),
    vehicleUnclear: ex?.vehicleVerdict === "unclear",
    // The shop offered a CHOICE. Without these two the primary engine could not
    // tell "I have two bikes at different prices" from "here is my price", and
    // read the ambiguity as "wrong vehicle" - closing a live negotiation.
    options: Array.isArray(ex?.options) ? ex.options : undefined,
    variance: text ? signalsVariance(text) : false,
    askedLocation: text ? shopAskedLocation(text) : false,
    askedQuestion: text ? shopAskedQuestion(text) : false,
    askedLicense: text ? shopAskedLicense(text) : false,
    askedLicensePhoto: text ? shopAskedLicensePhoto(text) : false,
    // The shop refused to lower ("last price") - the deterministic extractor
    // read it (agents.ts FIRM_RX) and it USED to be dropped on the floor here.
    firm: Boolean((ex as { shopFirm?: boolean } | null)?.shopFirm),
    // WHAT THE SHOP SENT. These all existed on ExtractedOffer and none of them
    // reached the primary engine, so a shop that answered with four price boards
    // looked identical to one that said nothing - and got asked to type it out.
    hadImage: input.event.kind === "inbound-image" || Boolean(ex?.imageKind),
    imageKind: ex?.imageKind,
    imageSummary: ex?.imageSummary || undefined,
    sheetPricePerDay:
      ex?.imageKind === "price_sheet" && typeof input.usablePrice === "number"
        ? input.usablePrice
        : undefined,
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
  // THE SHOP'S MENU, read across the WHOLE thread - a tier named three messages
  // ago is still on the table. Derived, never stored, for the same reason the
  // facts above are: the conversation is the state.
  const options = optionsFromThread([...inbound, curInbound], {
    vehicleClass: input.rfq.vehicleClass === "car" ? "car" : input.rfq.vehicleClass,
    // The declared spec scopes the menu: a shop's full price board must never
    // become a list of things to pick, and the traveller's licence declaration
    // covers only what they searched for.
    engineSizeCc: input.rfq.engineSizeCc,
    transmission: input.rfq.transmission,
    durationDays: input.rfq.durationDays,
    localCurrency: input.currency,
    depositNote: (input.extraction as { deposit?: string } | null)?.deposit || undefined,
  });
  return {
    ...base,
    round: facts.bargainRounds,
    quotedPricePerDay: input.usablePrice,
    tone,
    firmCount,
    depositKnown: facts.depositKnown,
    fulfillmentKnown: facts.fulfillmentKnown,
    lastOutbound: facts.lastOutbound,
    options: options.length >= 2 ? options : undefined,
  };
}

/** Build the session snapshot (blackboard read) from the shared session table:
 *  rivals = other shops' live quotes in the SAME currency; lowest = the session's
 *  cheapest quote across all shops. Best-effort - a read failure yields an empty
 *  snapshot (the single pass still composes a safe move, never invents a rival). */
async function buildSession(
  input: GraphTurnInput,
  io: GraphIO,
  verified: VerifiedExtraction
): Promise<SessionSnapshot> {
  const email = input.ctx.sender ?? "";
  const thisVendor = input.ctx.vendorId ?? "";
  let rivals: SessionSnapshot["rivals"] = [];
  let lowest: SessionSnapshot["lowest"] = null;
  if (email) {
    const rows = await io.sessionTable(email, thisVendor).catch(() => []);
    // WHICH CURRENCY IS THIS SESSION IN? Comparing across currencies without FX
    // would invent leverage, so the filter below is strict equality - but when
    // THIS thread is the odd one out (a single mis-stamped currency, exactly
    // what the "RM 300 in Krabi" bug produced), strict equality silently threw
    // away every rival and the shop quoting 300 never heard about the 250.
    // Trust the session's own majority over one thread's stamp.
    const priced = rows.filter((r) => typeof r.pricePerDay === "number" && r.currency);
    const tally = new Map<string, number>();
    for (const r of priced) tally.set(r.currency!, (tally.get(r.currency!) ?? 0) + 1);
    const dominant = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const compareCur =
      dominant && !tally.has(input.currency) && tally.get(dominant)! >= 2 ? dominant : input.currency;
    for (const r of rows) {
      if (typeof r.pricePerDay !== "number" || !r.currency) continue;
      if (r.currency !== compareCur) continue;
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
  // SITUATIONAL retrieval: the owner's lessons about THIS kind of message
  // (a menu on screen, a price board, a location request) instead of one
  // global tone block on every turn. Derived from verified facts, never from
  // the shop's wording.
  const { situationKinds } = await import("../ops/misread");
  const situation = situationKinds({
    optionCount: verified.options?.length,
    variance: verified.variance,
    hadImage: verified.hadImage,
    imageKind: verified.imageKind,
    askedLocation: verified.askedLocation,
    askedQuestion: verified.askedQuestion,
    declined: verified.declined,
    firm: verified.firm,
  });
  const { loadCoaching } = await import("./coaching");
  const coaching = await loadCoaching(situation).catch(() => "");
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
    case "option-probe":
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
  const verified = mapVerified(input);
  const session = await buildSession(input, io, verified);
  const text = input.event.kind === "inbound-text" || input.event.kind === "inbound-image"
    ? input.event.shopMessage ?? ""
    : "";
  // THE ONE DISCLOSURE GATE (parity with graph/nodes.ts:468). The primary
  // engine used to have no location facts at all, so `pickup-location` fell
  // through to `default: undefined` and the shop's "where are you?" went
  // unanswered. Composed ONLY from the server-verified stay - a client-posted
  // coordinate never reaches this.
  const { resolveShareableLocation } = await import("../location");
  const resolved = resolveShareableLocation(input.ctx.stay ?? null);
  const share = {
    addressText: resolved.addressText ?? undefined,
    mapsLink: resolved.mapsLink,
  };
  return {
    session,
    share,
    thread: {
      threadKey: input.event.threadKey,
      vendorId: input.ctx.vendorId ?? "",
      shop: input.ctx.vendorName ?? input.ctx.vendorId ?? "shop",
      digest: buildDigest(input),
    },
    tail: buildTail(input),
    inbound: { text, verified },
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
  // Clamped AGAIN here: this is the last gate before a durable not_before, and a
  // wait measured in hours is never a tactic, only a bug (the "until 08:28 AM"
  // incident on a thread the shop was actively typing in).
  const waitMinutes = clampWaitMinutes(outcome.waitMinutes);
  if (waitMinutes) {
    await io
      .insertWakeup({
        kind: "tick",
        threadKey: input.event.threadKey,
        notBefore: new Date(io.now() + waitMinutes * 60_000).toISOString(),
        payload: {
          userEmail: input.ctx.sender,
          vendorId: input.ctx.vendorId,
          engine: "v3",
          // The feed reads this instead of inventing generic copy.
          reason: `giving the shop ~${waitMinutes} min before the next nudge`,
          vendorName: input.ctx.vendorName,
        },
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
      // FIELD ORDER IS LOAD-BEARING. The blob is hard-capped below, so every
      // short analytical field comes first and the two long free-text fields
      // (`think`, `text`) come last - truncation can then only ever eat the tail
      // of a scratchpad, never a metric.
      detail: JSON.stringify({
        move: outcome.move,
        tier: outcome.route.tier,
        provider: outcome.route.provider ?? null,
        reason: outcome.route.reason,
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
        vehicleKey: vehicleKeyFor(input.rfq),
        // WHICH LEVERAGE ACTUALLY GOT PLAYED. `leverageUsed` was written by the
        // model every turn and read by nobody, so "the agents never use the
        // other shop's price" could not be measured, only noticed.
        leverage: outcome.artifact.leverageUsed ?? [],
        citedRival: Boolean(outcome.artifact.leverageUsed?.includes("rival")),
        // The shop's menu + what it sent, so the option and vision KPIs have a
        // source that is not a guess.
        options: tc.thread.digest.options?.length ?? 0,
        hadImage: Boolean(tc.inbound.verified.hadImage),
        imageKind: tc.inbound.verified.imageKind ?? null,
        think: outcome.artifact.think?.slice(0, 180),
        text: send?.slice(0, 180) ?? null,
      }).slice(0, 1600),
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
