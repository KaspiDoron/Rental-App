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
import { getPolicyOverlay, DEFAULT_OVERLAY, type PolicyOverlay } from "../ops/overlay";
import { getGraphSpec } from "../graph/engine";
/** The historical literal, kept as the config-outage fallback. It is the graph
 *  spec's own default (default-graph.ts:44), not the 6 that used to be here. */
const DEFAULT_MAX_ROUNDS = 4;
import { buildLedger } from "../thread/ledger";
import type { MoveKind, SessionSnapshot, ThreadDigest, TurnContext, VerifiedExtraction } from "./types";
import { shopAskedLocation, shopAskedLicense, shopAskedLicensePhoto } from "../wa/detectors";
import { shopAskedQuestion } from "../graph/nodes";
import { classifyActs } from "../wa/dialogue-acts";
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
  // WHAT THE SHOP DID, before anything decides how to answer it.
  const acts = classifyActs({
    text,
    hadImage: input.event.kind === "inbound-image" || Boolean(ex?.imageKind),
    imageKind: ex?.imageKind,
    pricePerDay: input.usablePrice,
    optionCount: Array.isArray(ex?.options) ? ex.options.length : 0,
  });
  // The legacy phrase list still widens the ask - it recognises real questions
  // the classifier's grammar test can miss ("you mean the 125?") - but it can
  // no longer promote a bare "?" or an automated greeting.
  if (acts.ask === "none" && !acts.autoReply && text && shopAskedQuestion(text) && /\?/.test(text)) {
    const stripped = text.replace(/\?/g, "");
    if (shopAskedQuestion(stripped)) acts.ask = "substantive";
  }
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
    // The identity gate's own verdict, which outranks the extractor's opinion:
    // it is computed from what the shop stated plus what the catalogue knows.
    vehicleStatus: ex?.vehicleAssessment?.status,
    vehicleQuestion: ex?.vehicleAssessment?.question,
    // The ask-once fact from the durable thread state (resolved in agent-loop,
    // persisted with the negotiation thread): once our confirm question has
    // gone out, a repeat is never legal - the engine proceeds as "assumed".
    vehicleAsked: Boolean(ex?.vehicleConfirmation?.askedAt),
    // The shop offered a CHOICE. Without these two the primary engine could not
    // tell "I have two bikes at different prices" from "here is my price", and
    // read the ambiguity as "wrong vehicle" - closing a live negotiation.
    options: Array.isArray(ex?.options) ? ex.options : undefined,
    variance: text ? signalsVariance(text) : false,
    askedLocation: text ? shopAskedLocation(text) : false,
    // A QUESTION MARK IS NOT A QUESTION. `shopAskedQuestion` is `/\?/` plus a
    // phrase list, so a price board captioned "...which model would you like?"
    // and an auto-reply's rhetorical "How many days rental?" both counted as
    // the shop waiting on us - which made `answer` the top legal move and fired
    // the "Good question!" template at a shop that had asked nothing. The acts
    // classifier decides now; the old detector stays as a widening OR only for
    // the phrase list it recognises, never for bare punctuation.
    askedQuestion: acts.ask !== "none",
    acts,
    askedLicense: text ? shopAskedLicense(text) : false,
    askedLicensePhoto: text ? shopAskedLicensePhoto(text) : false,
    // The shop refused to lower ("last price") - the deterministic extractor
    // read it (agents.ts FIRM_RX) and it USED to be dropped on the floor here.
    firm: Boolean((ex as { shopFirm?: boolean } | null)?.shopFirm),
    // OUT OF STOCK IS A STATE, and it is read from the thread's own claims -
    // the shop's last word on whether it has a vehicle at all. A later "we
    // have one now" un-sticks it with no special case.
    // (filled in by buildTurnContext from the thread ledger - the shop's own
    // last word on whether it has a vehicle at all)
    shopUnavailable: false,
    // WHAT THE SHOP SENT. These all existed on ExtractedOffer and none of them
    // reached the primary engine, so a shop that answered with four price boards
    // looked identical to one that said nothing - and got asked to type it out.
    hadImage: input.event.kind === "inbound-image" || Boolean(ex?.imageKind),
    imageKind: ex?.imageKind,
    imageSummary: ex?.imageSummary || undefined,
    // Our own read's provenance, not the shop's. `seen:false` means the vision
    // providers failed, so the engine must not act as though it had looked.
    imageUnread:
      (ex as { imageRead?: { seen?: boolean } } | null)?.imageRead?.seen === false || undefined,
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
    outboundKinds: input.priorOutboundKinds,
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
  // THE LEDGER: typed claims with POLARITY, the questions we have already put,
  // and the facts this thread still owes the traveller. Derived from the same
  // rows as everything else above, for the same reason.
  const ledger = buildLedger({ inbound, outbound, currentInbound: curInbound });
  return {
    ...base,
    round: facts.bargainRounds,
    quotedPricePerDay: input.usablePrice,
    tone,
    firmCount,
    // "No deposit" settles the deposit question exactly as firmly as "3000
    // baht". The old boolean only counted the second kind, so the friendliest
    // possible terms read as "unknown" and got asked about forever.
    depositKnown: facts.depositKnown || ledger.known.includes("deposit"),
    fulfillmentKnown: facts.fulfillmentKnown || ledger.known.includes("handover"),
    lastOutbound: facts.lastOutbound,
    options: options.length >= 2 ? options : undefined,
    ledger,
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
    // SAME VEHICLE. A quote for a different machine is not a rival, and citing
    // one at a shop is an argument we made up.
    const rows = await io
      .sessionTable(email, thisVendor, vehicleKeyFor(input.rfq))
      .catch(() => []);
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
    // ONE AGGREGATOR, AND IT KNOWS WHAT A RIVAL IS.
    //
    // This loop used to accept every priced row the session read returned, with
    // no test of whether the quote behind it was still one anyone could take.
    // A rival is a THREAT - "another shop is at 200" only moves a price because
    // the traveller could plausibly go there - so a withdrawn, dead or closed
    // shop is not leverage, it is noise that spends the one disclosure this
    // thread gets. validRivals is the shared predicate; it is pure, so the rule
    // is reviewable and testable in one screen.
    //
    // This runs inside buildSession, which every entry point reaches through
    // runThreadTurn - inline reply, scheduled wakeup and user action alike. It
    // used to be the inline path only, which before the routing fix meant every
    // scheduled follow-up negotiated with no cross-chat leverage at all.
    const { validRivals, sessionFloor } = await import("../negotiation/session-rivals");
    rivals = validRivals(rows, { excludeVendorId: thisVendor, currency: compareCur, limit: 4 });
    lowest = sessionFloor(rows, compareCur);
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
  // WHAT PAST TRAVELLERS ACTUALLY LANDED HERE.
  //
  // This was pinned to `null`, and `dealPrior` - which computes the median
  // achieved price and typical discount from `deal_memory` - had ZERO callers.
  // `rememberDeal` IS wired (negotiate/close-deal:208), so the table filled up
  // forever and was never read: after a thousand closed deals in Koh Samui, the
  // thousand-and-first negotiation anchored on exactly the same information as
  // the first. The prompt line that consumes it (pass.ts:47, "Past travellers
  // here landed around N/day") was permanently empty, and the self-improvement
  // loop the module header advertises was a no-op.
  //
  // Same region key the writer uses (lowercased free text), and dealPrior
  // already returns null below three samples so a thin prior cannot over-anchor.
  let priors: SessionSnapshot["priors"] = null;
  try {
    const regionKey = String(input.ctx.region ?? "").trim().toLowerCase();
    if (regionKey) {
      const { dealPrior } = await import("./memory");
      priors = await dealPrior(regionKey, input.rfq);
    }
  } catch {
    /* a prior is grounding, never a requirement - the turn proceeds without it */
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
    priors,
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
    case "farewell":
    case "closing-message":
    case "redirect-close":
      return "auto-close";
    default:
      return "reply";
  }
}

/**
 * The owner-tunable half of the policy: the clamped overlay and the graph
 * spec's round cap. `input.overlay` is set on the REPLAY path so the golden
 * suite stays bit-stable regardless of live config - the same contract the
 * graph engine uses at engine.ts:384.
 */
async function resolvePolicy(
  input: GraphTurnInput
): Promise<{ overlay: PolicyOverlay; maxRounds: number }> {
  const overlay =
    input.overlay ?? (await getPolicyOverlay().catch(() => DEFAULT_OVERLAY));
  const maxRounds = await getGraphSpec()
    .then((spec) => spec.settings.maxRoundsPerShop)
    .catch(() => DEFAULT_MAX_ROUNDS);
  return { overlay, maxRounds };
}

async function buildTurnContext(input: GraphTurnInput, io: GraphIO): Promise<TurnContext> {
  const policy = await resolvePolicy(input);
  const verified = mapVerified(input);
  const digest = buildDigest(input);
  // OUT OF STOCK IS A STATE (thread/ledger stockState), derived from the same
  // claims every other durable fact comes from - so "we have one now" un-sticks
  // it with no special case, and nothing has to be persisted.
  {
    const { stockState } = await import("../thread/ledger");
    const stock = stockState(digest.ledger);
    verified.shopUnavailable = stock.state === "out-of-stock";
    verified.restockHint = stock.restockHint;
  }
  // A SUBSTITUTION WAITING ON THE TRAVELLER pauses this thread instead of
  // closing it (policy.ts). Read from the stored thread state, so every entry
  // point - inbound reply, scheduled wakeup, user action - sees the same
  // pending choice.
  //
  // STALENESS IS JUDGED ON READ, not at write time, because a choice goes stale
  // by the passage of time and nothing writes to the row while a thread waits.
  // A shop that offered a 150 six hours ago has rented it, and a thread paused
  // on a tap that is never coming is a dead thread the traveller cannot see.
  try {
    const state = await io.loadState(input.event.threadKey);
    const stored = (state?.fields as { alternativeOffer?: { at?: number } } | undefined)
      ?.alternativeOffer;
    const { CHOICE_TTL_MS } = await import("../vehicle/substitution");
    digest.alternativeOffer =
      stored && typeof stored.at === "number" && Date.now() - stored.at < CHOICE_TTL_MS
        ? (stored as ThreadDigest["alternativeOffer"])
        : null;
  } catch {
    digest.alternativeOffer = null;
  }
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
      digest,
    },
    tail: buildTail(input),
    inbound: { text, verified },
    legalMoves: [], // computed deterministically inside runTurn (legalMovesFor)
    guards: {
      floorPerDay: input.floorPrice,
      // THE OWNER'S POLICY, READ WHERE IT IS ACTUALLY USED.
      //
      // `maxRounds: 6` was a literal, and the graph spec's owner-editable
      // `maxRoundsPerShop` defaults to 4 - so the PRIMARY engine allowed 50%
      // more pushes per shop than the configured policy, and the Ops slider
      // that sets it moved only the failover engine. Same for the two below.
      //
      // Both reads are already 30s-cached (getGraphSpec / getPolicyOverlay) and
      // both fall back to the historical literal, so a config outage keeps
      // today's behaviour rather than adopting a different one.
      maxRounds: policy.maxRounds,
      priceFarAboveFloor: policy.overlay.priceFarAboveFloor,
      bannedPhrases: policy.overlay.bannedPhrases,
    },
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

  // WHAT THE LAST MOVE ACHIEVED. The learning update needs the shop's ANSWER,
  // so it is credited one turn late - the digest still holds the quote the shop
  // was on before this reply, and the extraction holds the one it just gave.
  // Best-effort and awaited only because it is a memory write, not a send: it
  // can never fail the turn (see lib/learning/outcomes).
  {
    const { learnFromReply } = await import("../learning/outcomes");
    const { lastTacticId } = await import("../learning/last-move");
    await learnFromReply({
      tacticId: await lastTacticId(input.ctx.sender ?? "", input.event.toDigits),
      previousQuote: tc.thread.digest.quotedPricePerDay,
      newQuote: tc.inbound.verified.pricePerDay,
    }).catch(() => null);
  }

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
    // The freshness fingerprint - see wa/freshness.ts. A parked reply carries
    // what it was an answer to, so the drain can tell whether it still is one.
    composedAgainst: {
      inboundId: input.ctx.inboundId,
      inboundAt: new Date(startedAt).toISOString(),
      quotePerDay: tc.inbound.verified.pricePerDay,
      stockState: tc.inbound.verified.shopUnavailable ? "out-of-stock" : "unknown",
      move: outcome.move,
    },
  };

  let delivered: SpteLiveResult["delivered"] = "silent";
  // WHERE THE MESSAGE ENDED UP, when it did not go out. `delivered` is written
  // once into the turn detail at compose time and agent_events is append-only,
  // so a turn parked at 12:23 reads `queued` forever - which is a display bug
  // that has been read as a delivery bug more than once. Ops can now join to
  // the row and render what it is ACTUALLY doing right now.
  let outboxRowId: number | null = null;
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
      outboxRowId = res.outboxRowId ?? null;
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
  // THE BEST SHOP JUST FELL OVER.
  //
  // A shop declining or running out is ordinary and stays in the app. The
  // CHEAPEST shop of the session doing it is a different event entirely: the
  // traveller's whole plan was that number, everything else on the board is
  // dearer, and the agent has nothing left to do about it. That is the
  // agent-blocked class - not news competing for attention, the system saying
  // it cannot continue without them.
  //
  // Ko Tao, 12:38: LLL had quoted 180, the best of the hunt, and withdrew. The
  // phone said nothing.
  if (input.ctx.sender && (tc.inbound.verified.declined || tc.inbound.verified.shopUnavailable)) {
    const low = tc.session.lowest;
    const mine = tc.inbound.verified.pricePerDay ?? tc.thread.digest.quotedPricePerDay;
    const wasBest =
      Boolean(low) &&
      (low!.vendorId === input.ctx.vendorId ||
        (typeof mine === "number" && typeof low!.pricePerDay === "number" && mine <= low!.pricePerDay));
    if (wasBest) {
      void (async () => {
        try {
          const { worthAnInterruption } = await import("../notify/significance");
          const { notifyState, markPushSent } = await import("../notify/state");
          const g = worthAnInterruption({ kind: "agent-blocked" }, await notifyState(input.ctx.sender!));
          if (!g.notify) return;
          const m = await import("../push");
          await m.sendPushToUser(input.ctx.sender!, {
            title: "Your best price just fell through",
            body: `${input.ctx.vendorName ?? "The cheapest shop"} is out - your agents are still on the others, but this one needs your call.`,
            url: "/",
            tag: `lost:${input.ctx.vendorId ?? "best"}`,
          });
          await markPushSent(input.ctx.sender!, `agent-blocked: ${g.reason}`);
        } catch {
          /* a notification is never worth breaking a turn for */
        }
      })();
    }
  }

  // A SILENT TURN ON A PRICELESS THREAD MUST STILL COME BACK.
  //
  // `silent` schedules nothing - it is the reflex for "nothing is owed", and
  // for a thread that has its price and its terms that is exactly right. But
  // the same move is also where a thread lands when the shop said something
  // the engine could not act on ("Sorry,we do already discount."), and there
  // it means the opposite: everything is still owed and there is no event
  // coming that will re-enter this thread. The shop has answered, so no
  // inbound is due; nothing else ticks a specific thread. It simply stops.
  //
  // That is the A & T thread on Ko Tao - 28 minutes of silence on a shop that
  // was one nudge away from a quote. So a silent turn with no price on the
  // table schedules its own return, and the move set it comes back to now
  // contains `momentum` (see policy.ts).
  //
  // Bounded by the same one-nudge rule downstream: the wakeup re-runs the
  // policy, and a thread that has already been nudged simply goes silent again
  // - once, this time for good.
  const silentAndPriceless =
    outcome.move === "silent" &&
    typeof (tc.inbound.verified.pricePerDay ?? tc.thread.digest.quotedPricePerDay) !== "number" &&
    !tc.inbound.verified.declined &&
    !tc.inbound.verified.shopUnavailable;
  const waitMinutes = clampWaitMinutes(outcome.waitMinutes) ?? (silentAndPriceless ? 3 : undefined);
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
          // The feed reads this instead of inventing generic copy - so it has
          // to say which of the two this actually is.
          reason: silentAndPriceless
            ? `no price from them yet - checking back in ~${waitMinutes} min`
            : `giving the shop ~${waitMinutes} min before the next nudge`,
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
        // The provider's own failure reason when none answered. "no key" and
        // "every key is failing" used to look identical here.
        providerError: outcome.route.error ?? null,
        reason: outcome.route.reason,
        legalMoves: tc.legalMoves,
        floor: input.floorPrice ?? null,
        lowest: tc.session.lowest?.pricePerDay ?? null,
        rivals: tc.session.rivals.length,
        quote: input.usablePrice ?? null,
        materialDrop: outcome.materialDrop,
        delivered,
        outboxRowId,
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
