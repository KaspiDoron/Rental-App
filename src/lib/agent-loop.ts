// The agentic reply loop - shared by every inbound WhatsApp channel (official
// Meta Cloud API webhook AND per-user Evolution API sessions).
//
// Discipline (this is what makes the agent feel human, not robotic):
//   - The agent reads the WHOLE thread before speaking, so it never re-asks a
//     question the shop already answered.
//   - It clarifies AT MOST ONCE per shop. After that, any price the shop gave
//     is stored as an offer (unverified if needed) and the agent moves on.
//   - It bargains EXACTLY ONCE per shop: a single friendly ask anchored to the
//     real market floor for the area (see lib/market.ts). If the shop says no,
//     it thanks them and stops - no pushing, ever.
//   - Every automated outbound passes the Anti-Ban guard (lib/wa-guard.ts):
//     engagement halt, recipient business hours, dynamic reputation caps,
//     humanized content variance.

import "server-only";
import { sbInsert, sbSelect, sbUpdate } from "./runtime-config";
import { finishBeforeResponse } from "./after";
import { extractOffer, composeBargain, runSafety, currencyForRegion, money } from "./agents";
import {
  checkOutboundNumbers,
  claimedRivalNumber,
  correctDuration,
  buildSafeBargainAsk,
  stripRivalClaims,
  verbatimNumerals,
} from "./graph/guardrails";

/**
 * The strategist note is LLM free text. Pass it to the bargainer ONLY when it
 * does not assert a competitor PRICE we cannot vouch for: no rival number is
 * fine (a strategic hint), a number matching our one server-verified rival is
 * fine, anything else (an invented "another shop offered 220") is dropped whole.
 */
function safeLeverageNote(note: string | undefined, rivalPrice: number | undefined): string {
  const n = (note ?? "").trim();
  if (!n) return "";
  const claimed = claimedRivalNumber(n);
  if (claimed === undefined) return `Real leverage you may mention: ${n}.`;
  if (rivalPrice !== undefined && Math.abs(claimed - rivalPrice) <= Math.max(1, rivalPrice * 0.05)) {
    return `Real leverage you may mention: ${n}.`;
  }
  return ""; // asserts a rival price that is not our verified one - drop it
}
import { floorPriceFor, credibleFloor } from "./market";
import {
  guardOutbound,
  afterSend,
  recordInboundEngagement,
  claimForSend,
  releaseSendClaim,
} from "./wa-guard";
import { noteInboundDropped } from "./wa/webhook-trace";
import { waDigits, numberFilter } from "./wa/phone-key";
import { resolveThreadContext } from "./wa/thread-context";
import type { TraceRow } from "./orchestrator";
import type { StructuredRFQ, Vendor } from "./types";
import { digitsOnly } from "./phone";

export interface ThreadContext {
  sender?: string;
  vendorId?: string;
  vendorName?: string;
  kind?: string;
  round?: number;
  rfq?: StructuredRFQ | null;
  region?: string;
  plan?: string;
  channel?: string;
  localLang?: boolean;
  // The traveller's consented accommodation, stamped on the outbound at send
  // time so a shop asking "where is your hotel?" can be answered - never guessed.
  stay?: { label: string; lat?: number; lng?: number; shareConsent: boolean };
}

interface OutboundRow {
  id: number;
  to_number: string | null;
  raw: ThreadContext | null;
}

interface ThreadMsg {
  direction: "inbound" | "outbound";
  body: string | null;
  raw: ThreadContext | null;
  received_at: string;
}

export type SendFn = (
  to: string,
  message: string
) => Promise<{ ok: boolean; error?: string }>;

// Gracious one-time closers (varied further by the anti-ban content variator).
// CRITICAL: these must NEVER imply a deal is accepted or a booking confirmed
// ("that works", "I'll confirm") - only the traveller decides to close a deal,
// and the booking flow sends the real confirmation. These just end the
// exchange warmly while keeping every option open.
const CLOSE_OK = [
  "Thanks so much for the info! Let me think it over and I'll message you again.",
  "Really appreciate it, thank you! I'll check my plans and get back to you.",
];
const CLOSE_NO = [
  "No worries at all, thanks for letting me know! I'll think it over and get back to you.",
  "All good, I understand! Thanks for your time - I'll be in touch.",
];

// Did the shop ask US something? A question must be ANSWERED, never met with a
// canned thank-you (replying "sounds good!" to "you mean motorbike or car?" is
// the exact nonsense that makes the agent look like a bot).
function shopAskedQuestion(text: string): boolean {
  return (
    /\?/.test(text) ||
    /\b(you mean|do you mean|which (one|type|kind|model)|what (kind|type|size|model|dates?|day|time)|motor ?bike or car|car or (motor ?)?bike|scooter or (motor ?)?bike|how (many|long|much time)|when (do|will|are) you|where (are|do) you|pick ?up or delivery)\b/i.test(
      text
    )
  );
}

// Deterministic fallback answer when the LLM is unavailable: restate the exact
// request. Never guesses beyond the RFQ.
function fallbackAnswer(rfq: StructuredRFQ): string {
  const days = `${rfq.durationDays} day${rfq.durationDays === 1 ? "" : "s"}`;
  if (rfq.vehicleClass === "car") {
    const parts = [
      rfq.carType && rfq.carType !== "any" ? rfq.carType : "",
      rfq.transmission !== "any" ? rfq.transmission : "",
      "car",
      rfq.seats ? `${rfq.seats} seats` : "",
    ].filter(Boolean);
    return `A ${parts.join(" ")}, for ${days}. What would the daily price be?`;
  }
  const cc = rfq.engineSizeCc ? `${rfq.engineSizeCc}cc ` : "";
  const kind = rfq.vehicleClass === "scooter" ? "automatic scooter" : "manual motorbike";
  return `The ${cc}${kind} (not a car), for ${days}. What would the daily price be?`;
}

/** Process one inbound vendor message; auto-extract + auto-respond (once). */
/**
 * The NEVER-SILENT photo fallback (Module 3): when a shop sent an image but
 * the media download permanently failed or the OCR produced nothing usable,
 * the agent must ask warmly for the price in text instead of leaving the shop
 * on read. Shaped exactly like extractOffer's own degraded result so the
 * engine routes it through the normal clarify path (guard + human delay +
 * uniqueness all apply). matchesSpec stays true - "unreadable" must never be
 * mistaken for "wrong vehicle" (false would freeze the whole negotiation).
 */
export function photoClarifyExtraction(): import("./agents").ExtractedOffer {
  return {
    found: false,
    matchesSpec: true,
    confidence: "low",
    clarifyMessage:
      "We couldn't read that photo clearly - could you type the daily price out for us? 🙂",
  } as import("./agents").ExtractedOffer;
}

/**
 * Record how long THIS turn actually took, at the point the reply left our
 * hands. `composeMs` is the honest cost of the whole chain (extraction, engine
 * pass, validator, localization); `plannedDelayS` is the deliberate human
 * pacing on top. Fire-and-forget - a metric never delays a reply.
 */
function stampTurnLatency(
  email: string | undefined,
  toDigits: string,
  detail: { composeMs: number; plannedDelayS: number; outcome: string }
): void {
  if (!email) return;
  void sbInsert("agent_events", [
    {
      kind: "turn-latency",
      user_email: email,
      vendor_name: toDigits,
      detail: JSON.stringify(detail),
    },
  ]).catch(() => {});
}

export async function processVendorReply(opts: {
  fromDigits: string;
  text: string;
  waMessageId?: string;
  images?: { mime: string; base64: string }[];
  // Voice notes: the raw audio (transcribed here) and/or a pre-computed
  // transcript. The webhook downloads the audio; the engine's transcribe node
  // and the media-coherence validator handle the rest.
  audios?: { mime: string; base64: string }[];
  transcript?: { text: string; language?: string; source: string } | null;
  // The user whose WhatsApp received this reply. CRITICAL for multi-user
  // correctness: two users can bargain with the SAME shop, and the reply must
  // attach to THIS user's thread, never someone else's.
  senderEmail?: string;
  // The inbound message's TRUE origin chat JID (data.key.remoteJid). When
  // provided, we assert digitsOnly(remoteJid) === fromDigits before attributing
  // the reply, so a mis-scoped caller can never staple a personal chat onto a
  // shop thread. Defense-in-depth behind the per-message JID filter upstream.
  remoteJid?: string;
  // Queue the agent's reply with a natural "thinking" delay instead of
  // answering within seconds (instant replies are the biggest bot tell).
  // Only for senders whose own session can deliver from the queue.
  humanDelay?: boolean;
  // Module 3 (vision offload): a pre-computed extraction from the isolated
  // vision worker. When set, the in-turn extractOffer call is skipped - the
  // LLM-heavy OCR already ran at the vision queue's strict concurrency, and
  // this turn only composes/guards/sends. Also carries the NEVER-SILENT
  // fallback (photoClarifyExtraction) when the media/OCR pipeline failed.
  preExtracted?: import("./agents").ExtractedOffer;
  send: SendFn;
}): Promise<void> {
  // TURN LATENCY, MEASURED NOT ASSUMED. "Replies land in ~1-2 min" was a claim
  // nobody could check: the composer's delay was visible in the trace, but the
  // part that actually blew the ceiling - how long the LLM chain took before
  // that delay even started - was never recorded. This stamps the real number
  // at each terminal point so the doctor can show p50/p95 instead of a promise.
  const turnStartedAt = Date.now();
  let text = opts.text.trim();
  const images = opts.images ?? [];
  const transcript = opts.transcript ?? null;
  // A voice note carries its transcript as the message text so the whole
  // pipeline (extract -> coherence -> director) treats it exactly like an
  // inbound text, marked so the reasoning is transparent in traces.
  if (!text && transcript?.text) text = `(voice note) ${transcript.text}`.trim();
  // A price-list PHOTO or voice note with no caption is still a real reply.
  // When the media download FAILED (images empty, no text, but a real message
  // id exists), the shop DID answer - going silent here makes the app look
  // like the shop ghosted the user. Synthesize an honest placeholder so the
  // reply is visible everywhere and the agent politely asks for text.
  if (!text && images.length === 0) {
    if (!opts.waMessageId) return; // synthetic/system event - nothing real
    text = "(the shop sent a photo/attachment that couldn't be loaded)";
  }
  // waDigits (not digitsOnly): strips the multi-device JID suffix (":12") so a
  // multi-device reply keys to the same shop as the outbound anchor.
  const from = waDigits(opts.fromDigits);
  // ORIGIN ASSERTION (privacy): if the caller gave us the message's true chat
  // JID, it MUST match the number we are about to attribute this reply to. A
  // mismatch means the message came from a different chat (a personal contact
  // swept in by a mis-scoped read) - refuse to attribute it as a shop reply.
  if (opts.remoteJid) {
    const originDigits = waDigits(opts.remoteJid);
    const isPhoneJid = /@s\.whatsapp\.net$|@c\.us$/.test(opts.remoteJid);
    // Phone JIDs must match by digits; a privacy @lid JID cannot be verified
    // against a phone number, so we fail closed (do not attribute).
    if (!isPhoneJid || originDigits !== from) return;
  }
  const senderFilter = opts.senderEmail
    ? `&raw->>sender=eq.${encodeURIComponent(opts.senderEmail)}`
    : "";

  // Find the thread through THE shared resolver (src/lib/wa/thread-context.ts).
  // It scans a window of recent outbound rows for the newest one carrying an
  // RFQ, instead of demanding that the very newest row carry it. That single
  // change is what stops one human-manual takeover row - or one send whose
  // client omitted body.rfq - from orphaning a live negotiation forever.
  // Number matching is spelling-tolerant, so threads stored under a national
  // format ("09661952196") still resolve for an international inbound.
  const resolved = await resolveThreadContext(from, opts.senderEmail ?? "");
  const ctx = resolved.ctx as (OutboundRow["raw"] & { rfq?: unknown }) | null;
  // ATTRIBUTION FALLBACK: the RFQ anchor row and the identity row (newest
  // raw.vendorId) can be DIFFERENT rows. When the anchor lost its vendorId,
  // every derived row (vendor_replies, offers, events) was written with
  // vendor_id "" - persisted but unreadable by every card surface, the
  // textbook stored-but-invisible reply. The identity row's vendorId fills
  // the gap; a thread with neither leaves a trace instead of writing rows
  // no card can ever find.
  if (ctx && !ctx.vendorId && resolved.vendorId) ctx.vendorId = resolved.vendorId;
  if (ctx && !ctx.vendorId) {
    void noteInboundDropped(opts.senderEmail, from, "derived-unattributed", {
      note: "thread carries no vendorId - derived rows would be invisible to cards",
    });
  }
  if (!resolved.rfq || !ctx) {
    // Still no anchor: we genuinely never sent this number an RFQ. Trace it so
    // the WA doctor can explain "why no agent reply" instead of going silent.
    void noteInboundDropped(opts.senderEmail, from, "no-rfq-thread", {
      anchors: resolved.anchors,
      gate: resolved.reason,
    });
    return; // reply without a known thread - stored, not processed
  }

  // ---- EXACTLY ONE TURN, AND ONLY WHILE WE ARE ACTUALLY TAKING IT ----------
  //
  // Both claims live HERE, after the thread resolves, for reasons that are the
  // opposite sides of one mistake:
  //
  //   - The reply claim used to be taken at the very top, before we even knew
  //     whether this was a thread we own, and was never released. Any turn that
  //     threw left the message permanently un-replyable and un-replayable, with
  //     no trace: one shop out of seven silently never answered. It is a LEASE
  //     now - released in `finally` unless we actually delivered something.
  //
  //   - There was no per-THREAD exclusion at all. Two webhook frames from the
  //     same shop each won their own message claim and each composed a reply,
  //     because every "have we already said this?" counter reads the outbound
  //     row, which is written only after the send. Two duplicate bargains in
  //     the same minute.
  const senderKeyForTurn = opts.senderEmail ?? "";
  let holdsTurn = false;
  let claimedReply = false;
  let turnDelivered = false;

  if (opts.waMessageId) {
    const { sbInsertReturning } = await import("./runtime-config");
    const claimed = await sbInsertReturning<{ wa_message_id: string }>("wa_processed", [
      { wa_message_id: opts.waMessageId },
    ]);
    if (claimed.length === 0) {
      const existing = await sbSelect(
        "wa_processed",
        `select=wa_message_id&wa_message_id=eq.${encodeURIComponent(opts.waMessageId)}&limit=1`
      ).catch(() => []);
      if (existing.length > 0) return; // another delivery already owns it
      // wa_processed missing/unreachable -> legacy best-effort dedupe.
      const dup = await sbSelect(
        "whatsapp_messages",
        `select=id&wa_message_id=eq.${encodeURIComponent(opts.waMessageId)}&direction=eq.inbound&limit=2`
      );
      if (dup.length > 1) return;
    } else {
      claimedReply = true;
    }
  }

  // Captured ONCE so claim and release compute the SAME buckets - a release
  // computed at its own time deleted a slot the claim never took whenever
  // the turn straddled a 60s bucket boundary (see wa/turn-lock).
  const turnClaimedAtMs = Date.now();
  try {
    const { claimThreadTurn, releaseThreadTurn } = await import("./wa/turn-lock");
    const turn = await claimThreadTurn(senderKeyForTurn, from, turnClaimedAtMs);
    if (turn === "lost") {
      // A sibling turn owns this thread right now. Do NOT compose a second
      // reply against a thread state that is about to change. Hand the message
      // back so the burst is answered once, as one coalesced turn.
      if (claimedReply && opts.waMessageId) {
        const { releaseReplyClaim } = await import("./wa/inbound-claim");
        await releaseReplyClaim(opts.waMessageId);
      }
      void noteInboundDropped(opts.senderEmail, from, "turn-in-flight", {
        note: "another delivery is mid-turn for this thread; released for the winner to coalesce",
      });
      return;
    }
    holdsTurn = turn === "won";
    void releaseThreadTurn; // released in the finally below

    return await runVendorTurn();
  } finally {
    const { releaseThreadTurn } = await import("./wa/turn-lock");
    if (holdsTurn) await releaseThreadTurn(senderKeyForTurn, from, turnClaimedAtMs);
    // A turn that did not deliver has not consumed the message. Give the claim
    // back so a redelivery or the recovery sweep can answer it.
    if (claimedReply && !turnDelivered && opts.waMessageId) {
      const { releaseReplyClaim } = await import("./wa/inbound-claim");
      await releaseReplyClaim(opts.waMessageId);
    }
  }

  async function runVendorTurn(): Promise<void> {
  // Already guaranteed by the guard above; restated because narrowing does not
  // cross the closure boundary.
  if (!ctx) return;
  const priorAt = resolved.newestAt;
  // "(unverified)" PURGE at the source: a historical thread whose outbound meta
  // carries the legacy drill suffix must not propagate it into pushes, events,
  // offers or engine turns.
  if (ctx.vendorName) {
    const { cleanShopName } = await import("./text");
    ctx.vendorName = cleanShopName(ctx.vendorName);
  }

  // SESSION LIFECYCLE GUARD: if the user closed the search session AFTER our
  // last outbound in this thread, the thread is DEAD. We still store the reply
  // below (data is never lost) but the agent says nothing more - a closed
  // session must never keep talking to shops. A new search re-opens the shop
  // with a fresh outbound, which then postdates the marker.
  let sessionClosed = false;
  if (ctx.sender && priorAt) {
    const marker = await sbSelect<{ received_at: string }>(
      "whatsapp_messages",
      `select=received_at&to_number=eq.session&raw->>sender=eq.${encodeURIComponent(
        ctx.sender
      )}&raw->>kind=eq.session-closed&order=received_at.desc&limit=1`
    );
    sessionClosed = Boolean(marker[0] && marker[0].received_at > priorAt);
  }

  const rfq = ctx.rfq as StructuredRFQ;
  const round = Number(ctx.round ?? 0);

  // A reply arrived: build the sender's trust score (anti-ban engagement).
  if (ctx.sender) await recordInboundEngagement(ctx.sender, from);

  // Read the recent thread so the agent has real memory - SCOPED AT THE DB so a
  // co-user's chat with the SAME shop number can never (a) leak into this
  // context or (b) evict this user's rows out of a shared limit window (the
  // old fetch-ALL-then-filter with limit=20 let a busy co-user starve this
  // user's memory and re-trigger ask-once). Two receiver/sender-scoped reads,
  // merged. Fail CLOSED: with no receiver scope we cannot build a cross-user-
  // safe history, so we use none rather than the unfiltered set.
  let mine: ThreadMsg[] = [];
  if (opts.senderEmail) {
    const encMe = encodeURIComponent(opts.senderEmail);
    const [outRows, inRows] = await Promise.all([
      sbSelect<ThreadMsg>(
        "whatsapp_messages",
        `select=direction,body,raw,received_at&direction=eq.outbound&raw->>sender=eq.${encMe}&order=received_at.desc&limit=12${numberFilter(
          "to_number",
          from
        )}`
      ),
      sbSelect<ThreadMsg>(
        "whatsapp_messages",
        `select=direction,body,raw,received_at&direction=eq.inbound&raw->>receiver=eq.${encMe}&order=received_at.desc&limit=12${numberFilter(
          "from_number",
          from
        )}`
      ),
    ]);
    mine = [...outRows, ...inRows].sort(
      (a, b) => Date.parse(b.received_at) - Date.parse(a.received_at)
    );
  }
  const thread = mine.slice(0, 12).reverse();
  const history = thread
    .map((m) => `${m.direction === "outbound" ? "Us" : "Shop"}: ${(m.body ?? "").slice(0, 300)}`)
    .join("\n");
  // MULTI-MESSAGE COALESCING (critical data-loss fix): a shop often sends a
  // burst of separate messages - "Good day!" / "We have available Fazzio" /
  // "Regular rate is 550, we can give you 400 per day" - each arriving as its
  // OWN webhook. Extracting from the single triggering frame binds a bare price
  // to no vehicle (matchesSpec=false -> the offer is dropped, UI stuck on "No
  // price yet"). Instead, extract from the WHOLE unread inbound buffer since our
  // last outbound, chronologically, so one read sees the vehicle AND its price.
  const { coalesceUnreadInbound } = await import("./wa/coalesce");
  const extractText = coalesceUnreadInbound(thread, priorAt ?? "", text) || text;
  // PENDING REPLIES COUNT TOO. A reply parked in wa_outbox with a human
  // "thinking" delay is NOT yet in whatsapp_messages. Without counting it, a
  // SECOND shop message arriving inside that 45-240s window reads the counters
  // as zero and queues ANOTHER bargain/clarify - the exact double-ask this
  // discipline exists to prevent. Include the pending outbox for this thread.
  const pendingOutbox = ctx.sender
    ? await sbSelect<{ meta: { kind?: string } | null }>(
        "wa_outbox",
        `select=meta&sender_key=eq.${encodeURIComponent(ctx.sender)}&limit=20${numberFilter(
          "to_number",
          from
        )}`
      ).catch(() => [])
    : [];
  const pendingKind = (k: string) =>
    pendingOutbox.filter((r) => r.meta?.kind === k).length;

  const autoClarifies =
    thread.filter((m) => m.direction === "outbound" && m.raw?.kind === "auto-clarify").length +
    pendingKind("auto-clarify");
  // COUNT EVERY BARGAIN, including the ones the USER tapped from the app
  // (kind "bargain"). Counting only auto-bargains made the loop push a SECOND
  // ask after a user-initiated one - the "asked twice after the shop said no"
  // bug. One ask per shop means one ask, whoever triggered it.
  const autoBargains =
    thread.filter(
      (m) =>
        m.direction === "outbound" &&
        // SPTE stamps the semantic move in raw.move; the legacy paths use
        // raw.kind. Count BOTH so a thread whose sends were mis-stamped "reply"
        // (the round-cap-never-binds bug) still heals its round counter.
        (m.raw?.kind === "auto-bargain" ||
          m.raw?.kind === "bargain" ||
          (m.raw as { move?: string } | null)?.move === "bargain")
    ).length +
    pendingKind("auto-bargain") +
    pendingKind("bargain");
  const autoAnswers =
    thread.filter((m) => m.direction === "outbound" && m.raw?.kind === "auto-answer").length +
    pendingKind("auto-answer");
  const autoCloses =
    thread.filter((m) => m.direction === "outbound" && m.raw?.kind === "auto-close").length +
    pendingKind("auto-close");

  // Funnel-gap detector: shops that dodge with "come to the shop and we'll
  // talk" / "depends" answers are logged as an owner signal, so real gaps can
  // be turned into new branching rules in the decision graph (Admin -> Agents).
  const vague =
    /\b(come (to|by|visit)|visit (us|our shop|the shop)|see for yourself|talk (at|in) the shop|depends|not sure|we'?ll see|call us|stop by)\b/i.test(
      text
    );
  if (vague) {
    sbInsert("agent_events", [
      {
        kind: "vague-reply",
        vendor_id: ctx.vendorId ?? "",
        vendor_name: ctx.vendorName ?? "",
        detail: text.slice(0, 500),
      },
    ]).catch(() => {});
  }

  // INBOUND SAFETY SCREEN - STARTED BEFORE THE EXTRACTION IT USED TO FOLLOW.
  // It is fire-and-forget either way, so it never blocked the turn; but sitting
  // after the extractor meant its own LLM call only BEGAN once the extraction
  // had finished, and the traveller learned a message was dangerous seconds
  // after their agent had already answered it. Nothing here depends on the
  // extraction, so the two run side by side and the warning arrives first.
  // INBOUND SAFETY SCREEN (fire-and-forget): flag risky shop asks - passport
  // photos, off-platform transfers, shady links - for the USER. Never touches
  // what the engine replies.
  //
  // NEVER SELF-FLAG: a message the user wrote themselves (a lost fromMe flag
  // upstream can mislabel it inbound) must not be screened as "the shop's
  // reply" - anything matching our recent outbound to this number is skipped.
  if (ctx.sender && text) {
    await finishBeforeResponse("risk-screen", async () => {
      try {
        const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
        const ours = await sbSelect<{ body: string }>(
          "whatsapp_messages",
          `select=body&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
            ctx.sender!
          )}&received_at=gte.${encodeURIComponent(
            new Date(Date.now() - 24 * 3600_000).toISOString()
          )}&order=received_at.desc&limit=30${numberFilter("to_number", from)}`
        ).catch(() => [] as { body: string }[]);
        if (ours.some((o) => norm(o.body || "") === norm(text))) return;
        const { screenInbound } = await import("./inbound-risk");
        const verdict = await screenInbound(text, { vendorName: ctx.vendorName ?? undefined });
        if (verdict.risk === "none") return;
        // user_email column = EXACT ownership scoping for the risk feed (the
        // old detail LIKE *email* filter leaked alerts across users whose
        // emails were substrings). Retry without the column pre-migration.
        const riskRow = {
          kind: "inbound-risk",
          vendor_id: ctx.vendorId ?? "",
          vendor_name: ctx.vendorName ?? "",
          detail: JSON.stringify({
            email: ctx.sender,
            risk: verdict.risk,
            reasons: verdict.reasons,
            excerpt: text.slice(0, 200),
          }),
        };
        const stamped = await sbInsert("agent_events", [
          { ...riskRow, user_email: ctx.sender ?? null },
        ]);
        if (!stamped) await sbInsert("agent_events", [riskRow]);
        // THROUGH THE GATE, like everything else. A risk always passes it -
        // it is a handover, not news, and is deliberately exempt from the
        // budget - but it must go through the ONE door so it is recorded, and
        // so the ceiling counts what actually reached the phone. This site
        // bypassed both and never called markPushSent, which is what made the
        // 4-per-hour limit advisory rather than real.
        const { worthAnInterruption } = await import("./notify/significance");
        const { notifyState, markPushSent } = await import("./notify/state");
        const pushState = await notifyState(ctx.sender!);
        const gate = worthAnInterruption({ kind: "risk" }, pushState);
        if (!gate.notify) return;
        const { sendPushToUser } = await import("./push");
        await sendPushToUser(ctx.sender!, {
          title: verdict.risk === "high" ? "⚠️ Check this reply" : "Heads up on a reply",
          body: `${ctx.vendorName || "A shop"}: ${verdict.reasons[0] ?? "review this message before acting"}`,
          url: ctx.vendorId ? `/?shop=${encodeURIComponent(ctx.vendorId)}` : "/",
          // ITS OWN LANE. A safety warning must never be collapsed away by an
          // ordinary reply push (the shared default tag did exactly that), and
          // it must not silently replace one either.
          tag: `risk:${from}`,
        });
        await markPushSent(ctx.sender!, `risk: ${gate.reason}`);
      } catch {
        /* screening is best-effort */
      }
    });
  }

  const extraction =
    opts.preExtracted ??
    (await extractOffer(
      rfq,
      extractText || "(the shop sent a price-list photo)",
      images,
      history,
      ctx.region || undefined
    ));
  // NOTE: evaluated lazily (a getter-style function, not a const) because the
  // vehicle gate + thread-confirmation blocks below may still upgrade or
  // downgrade the extraction. VERIFIED now also requires the VEHICLE to be
  // established: with unconfirmed prices becoming real (unverified) offers,
  // a high-confidence read alone must not wear the green badge.
  const isVerified = () =>
    Boolean(
      extraction.found &&
        extraction.matchesSpec &&
        extraction.confidence === "high" &&
        (!extraction.vehicleAssessment || extraction.vehicleAssessment.status === "confirmed")
    );
  // After we've clarified once, a found price counts even if not fully
  // verified - the human can see it; the agent must not nag the shop again.
  let usablePrice =
    extraction.found && extraction.pricePerDay
      ? extraction.pricePerDay
      : undefined;

  // DETERMINISTIC BACKSTOP (the "3 of 4 offers vanished" fix): the LLM
  // extractor can miss/fail (quota, odd phrasing) - but a price a human can
  // read in the text must NEVER be dropped. extractRentalDailyPrice reads the
  // reply line-by-line (monthly/weekly totals, k-notation, bare-number answers)
  // and rescues the quote; a wrong-vehicle line (classMatch=false) is never
  // rescued into the requested vehicle's offer.
  if (!usablePrice && extractText) {
    const { extractRentalDailyPrice } = await import("./wa/price-extract");
    const det = extractRentalDailyPrice(extractText, {
      vehicleClass: rfq.vehicleClass === "car" ? "car" : rfq.vehicleClass,
      durationDays: rfq.durationDays,
      localCurrency: currencyForRegion(ctx.region || undefined) ?? undefined,
    });
    if (det && det.classMatch !== false) {
      usablePrice = det.pricePerDay;
      extraction.found = true;
      extraction.pricePerDay = det.pricePerDay;
      if (!extraction.currency && det.currency) extraction.currency = det.currency;
      // A deterministic rescue is honest but not "high" confidence.
      if (extraction.confidence !== "high") extraction.confidence = "medium";
    }
  }

  // ===== TWO ENGINES, ONE TRUTH (reconciliation) ============================
  //
  // The LLM extractor and the deterministic reader used to run in SEQUENCE -
  // deterministic only on an LLM miss - so an LLM MISREAD was never
  // cross-checked. Thailand: "6 days 180 per day" divided by the model into
  // ฿30/day while the deterministic reader had the correct 180 all along, and
  // "1100b./6days" vanished entirely when the model missed and the (then
  // token-blind) reader had no net. Now every LLM price is reconciled against
  // the deterministic read: algebra decides the clear cases (a division
  // artifact reconstructs the other engine's number), and a genuine semantic
  // disagreement goes to ONE structured arbiter call - the LLM owns semantics,
  // the algebra owns arithmetic, neither is trusted alone.
  if (usablePrice && extractText) {
    try {
      const { extractRentalDailyPrice } = await import("./wa/price-extract");
      const det = extractRentalDailyPrice(extractText, {
        vehicleClass: rfq.vehicleClass === "car" ? "car" : rfq.vehicleClass,
        durationDays: rfq.durationDays,
        localCurrency: currencyForRegion(ctx.region || undefined) ?? undefined,
      });
      const dur = rfq.durationDays;
      const close = (a: number, b: number) => b > 0 && Math.abs(a - b) / b <= 0.1;
      if (det && det.classMatch !== false && det.pricePerDay > 0 && det.pricePerDay !== usablePrice) {
        const adopt = async (why: string) => {
          await sbInsert("agent_events", [
            {
              kind: "price-reconciled",
              vendor_id: ctx.vendorId ?? "",
              vendor_name: ctx.vendorName ?? "",
              user_email: ctx.sender ?? "",
              detail: `${why}: LLM read ${usablePrice}, deterministic read ${det.pricePerDay} - using ${det.pricePerDay}. "${(extractText ?? "").slice(0, 160)}"`,
            },
          ]).catch(() => {});
          usablePrice = det.pricePerDay;
          extraction.pricePerDay = det.pricePerDay;
          if (det.currency) extraction.currency = det.currency;
          if (extraction.confidence === "high") extraction.confidence = "medium";
        };
        if (dur > 1 && close(usablePrice * dur, det.pricePerDay)) {
          // The model divided a number the shop stated whole/per-day.
          await adopt("misdivision (LLM = deterministic / days)");
        } else if (dur > 1 && close(det.pricePerDay * dur, usablePrice)) {
          // The model took the whole-rental total at face value; the reader
          // saw the denominator and divided it.
          await adopt("total taken as daily (deterministic = LLM / days)");
        } else if (Math.abs(det.pricePerDay - usablePrice) / usablePrice > 0.25) {
          // Semantic disagreement - ask once, with the full context.
          const { arbitratePriceBasis } = await import("./agents");
          const llmBefore = usablePrice;
          const pick = await arbitratePriceBasis({
            message: extractText,
            durationDays: dur,
            candidateA: llmBefore,
            candidateB: det.pricePerDay,
          }).catch(() => null);
          if (pick !== null && close(pick, det.pricePerDay)) {
            await adopt("arbiter sided with the deterministic read");
          } else if (pick !== null && !close(pick, llmBefore)) {
            // The arbiter named a third number - never adopt an un-grounded
            // amount; keep the LLM read and record the disagreement.
            await sbInsert("agent_events", [
              {
                kind: "price-arbiter-odd",
                vendor_id: ctx.vendorId ?? "",
                vendor_name: ctx.vendorName ?? "",
                user_email: ctx.sender ?? "",
                detail: `Arbiter said ${pick}; candidates were ${llmBefore} (LLM) and ${det.pricePerDay} (det). Kept ${llmBefore}.`,
              },
            ]).catch(() => {});
          }
        }
      }
    } catch {
      /* reconciliation is a net - its failure must never drop a reply */
    }
  }

  // DURATION-LADDER OVERRIDE. A price board is not a list of numbers to choose
  // from - each row is the rate you earn by staying that long. The vision half
  // has no way to know that, and on 26 Jul it quoted a five-day traveller the
  // 15-29 day rate off a board it had also read the wrong vehicle from. The
  // ladder is fully determined by the text, so code decides it, not the model:
  // whichever row COVERS the traveller's dates is the price, full stop.
  if (extractText) {
    const { ladderRateFor } = await import("./wa/rate-ladder");
    const board = ladderRateFor(extractText, rfq.durationDays, {
      localCurrency: currencyForRegion(ctx.region || undefined) ?? undefined,
    });
    if (board && board.pricePerDay > 0) {
      usablePrice = board.pricePerDay;
      extraction.found = true;
      extraction.pricePerDay = board.pricePerDay;
      if (board.tier.currency) extraction.currency = board.tier.currency;
      // The board states its own terms - reading a row off it is a fact, not a
      // guess, so it may confirm but never downgrade a verified read.
      if (extraction.confidence !== "high") extraction.confidence = "medium";
    }
  }

  // ===== VEHICLE IDENTITY GATE ============================================
  //
  // The single choke point where "is this price even for their vehicle?" is
  // decided, for both engines and for every surface downstream.
  //
  // Two live threads reached the traveller's screen as "BEST PRICE ₱400" for a
  // 110cc when they had declared a 125:
  //
  //   "for the Honda beat sir 400 pesos sir for the honda click 125 500 pesos"
  //   "I already gave 500 for you. If you want 110cc 400 per day"
  //
  // Neither was a parsing failure. There was no concept of a price BELONGING to
  // a vehicle, so the cheapest number won and an unnamed vehicle defaulted to
  // "must be theirs". src/lib/vehicle owns that concept now: it pairs every
  // quote with the vehicle beside it, resolves that vehicle's attributes from
  // what the shop stated and what the catalogue knows, and returns one of three
  // states. Only `confirmed` may become an offer - `needs-confirmation` becomes
  // a question the agent has to ask first, and it cannot be skipped.
  const declared = {
    class: rfq.vehicleClass === "car" ? ("car" as const) : (rfq.vehicleClass as "scooter" | "motorbike"),
    displacementCc: rfq.engineSizeCc,
    transmission: rfq.transmission === "any" ? undefined : rfq.transmission,
    seats: rfq.seats,
  };
  if (extractText && usablePrice) {
    const { assessPrice } = await import("./vehicle/resolution");
    const { pickOurPrice } = await import("./vehicle/resolution");
    const { extractQuotedPrices } = await import("./wa/price-extract");
    const { amountIndexIn } = await import("./wa/rate-expr");

    // Every amount the shop wrote, each with WHERE it sits - the position is
    // what lets one sentence carrying two vehicles be read as two offers.
    const quoted = extractQuotedPrices(extractText, {
      vehicleClass: rfq.vehicleClass === "car" ? "car" : rfq.vehicleClass,
      durationDays: rfq.durationDays,
      localCurrency: currencyForRegion(ctx.region || undefined) ?? undefined,
    });
    const candidates = quoted.allOffers.map((h) => ({
      pricePerDay: h.pricePerDay,
      currency: h.currency,
      index: amountIndexIn(extractText, h.pricePerDay),
    }));
    // The price the model chose is a candidate like any other, judged the same.
    if (!candidates.some((c) => c.pricePerDay === usablePrice)) {
      candidates.push({
        pricePerDay: usablePrice,
        currency: extraction.currency ?? undefined,
        index: amountIndexIn(extractText, usablePrice),
      });
    }

    const ours = candidates.length > 1 ? pickOurPrice(extractText, declared, candidates) : null;
    if (ours && ours.price !== usablePrice) {
      // A different amount in the same reply is the one that belongs to the
      // traveller's vehicle. This is the Joh's Matics correction: 500, not 400.
      usablePrice = ours.price;
      extraction.pricePerDay = ours.price;
      if (ours.currency) extraction.currency = ours.currency;
    }

    const assessment = assessPrice(extractText, declared, {
      pricePerDay: usablePrice,
      currency: extraction.currency ?? undefined,
      index: amountIndexIn(extractText, usablePrice),
    });
    extraction.vehicleAssessment = {
      status: assessment.status,
      reason: assessment.judgement.reason,
      question: assessment.question,
      travellerNote: assessment.travellerNote,
      missing: assessment.missing,
      model: assessment.judgement.identity.model?.name,
    };
    // THE OVERRIDE. The catalogue outranks the model's opinion about what a
    // nameplate is: a BeAT is 110cc whether or not the extractor noticed.
    if (assessment.status === "wrong-vehicle") {
      extraction.vehicleVerdict = "mismatch";
      extraction.matchesSpec = false;
    } else if (assessment.status === "needs-confirmation") {
      extraction.vehicleVerdict = "unclear";
      // NOT forced to matchesSpec=false anymore. "Unresolved" starved every
      // downstream surface at once in the field: no offers row, no BEST PRICE,
      // no rival for the leverage engine, a card frozen on the old quote. An
      // unconfirmed price is now an UNVERIFIED offer, and the thread-level
      // resolution below is what retires the question.
    }
  }

  // ===== THREAD-LEVEL VEHICLE CONFIRMATION =================================
  //
  // The assessment above judges THIS message in isolation - and a shop that
  // answers our question about a 125cc automatic with "6 days 180 per day"
  // proves nothing to it, forever. The conversation proves it: our own
  // outbound named the vehicle, the shop answered it directly. That fact is
  // durable (negotiation_threads.fields.vehicleConfirmation, persisted by
  // applyExtractionToState), never regresses, and retires the confirm
  // question after ONE ask.
  if (extractText && ctx.sender) {
    try {
      const { resolveConfirmation } = await import("./vehicle/confirmation");
      const { loadThreadState, threadKeyFor } = await import("./graph/state");
      const prevState = await loadThreadState(threadKeyFor(ctx.sender, from)).catch(() => null);
      const prevConf = (prevState?.fields as {
        vehicleConfirmation?: import("./vehicle/confirmation").VehicleConfirmationState;
      } | null)?.vehicleConfirmation;
      const lastOut = await sbSelect<{ body: string }>(
        "whatsapp_messages",
        `select=body&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
          ctx.sender
        )}&order=received_at.desc&limit=1${numberFilter("to_number", from)}`
      ).catch(() => [] as { body: string }[]);
      const conf = resolveConfirmation(prevConf, {
        declared,
        inboundText: extractText,
        lastOutboundText: lastOut[0]?.body ?? "",
        messageStatus: extraction.vehicleAssessment?.status ?? null,
        hasPrice: Boolean(usablePrice),
      });
      extraction.vehicleConfirmation = conf;
      // A confirmed THREAD upgrades this message's verdict: the price on the
      // table belongs to the vehicle the conversation already established, so
      // no surface may keep asking and no offer stays "unverified".
      if (conf.status === "confirmed" && extraction.vehicleAssessment?.status === "needs-confirmation") {
        extraction.vehicleAssessment = {
          ...extraction.vehicleAssessment,
          status: "confirmed",
          question: "",
          travellerNote: "",
          reason: conf.evidence,
        };
        extraction.vehicleVerdict = undefined;
      }
      // OUT OF STOCK IS A STATE, resolved from the same conversation and made
      // durable the same way. "Now I don't have bike." used to match nothing
      // anywhere: no claim, no state, no card - so the agent kept haggling
      // over a scooter that did not exist and the traveller kept waiting for a
      // price. A later "we have one now" flips it back with no special case,
      // because it is read from the shop's LAST availability claim.
      const { buildLedger, stockState } = await import("./thread/ledger");
      const stock = stockState(
        buildLedger({
          inbound: thread
            .filter((m) => m.direction === "inbound")
            .map((m) => m.body ?? "")
            .filter(Boolean),
          outbound: thread
            .filter((m) => m.direction === "outbound")
            .map((m) => m.body ?? "")
            .filter(Boolean),
          currentInbound: extractText,
        })
      );
      extraction.shopUnavailable = stock.state === "out-of-stock";
      extraction.restockHint = stock.restockHint;
    } catch {
      /* confirmation is an upgrade - its failure must never drop a reply */
    }
  }

  // CURRENCY TRUTH. A currency other than the shop's own is honoured only when
  // the shop actually typed it - a photo-only reply or a mis-read token can
  // never turn a Thai quote into ringgit ("RM 300/day" on a Krabi thread).
  const { reconcileCurrency } = await import("./wa/price-extract");
  const cur =
    reconcileCurrency(
      extraction.currency,
      currencyForRegion(ctx.region || undefined),
      extractText || ""
    ) || "USD";

  // THE SHOP'S MENU. A reply naming more than one price is a CHOICE, not a
  // quote: "some models 200 and some new 250/day". Collapsing that to one number
  // is what hid the 200 tier from the traveller and left the agent haggling a
  // price nobody had picked. Derived deterministically from the same reader that
  // produced the price, then merged with anything the model itself listed.
  {
    const { extractQuotedPrices } = await import("./wa/price-extract");
    const { optionsFromHits, mergeOptions, sectionHeaders } = await import("./offer-options");
    const quoted = extractQuotedPrices(extractText || "", {
      vehicleClass: rfq.vehicleClass === "car" ? "car" : rfq.vehicleClass,
      durationDays: rfq.durationDays,
      localCurrency: cur,
    });
    const derived = optionsFromHits(quoted.allOffers, {
      depositNote: extraction.deposit || undefined,
      source: images.length > 0 ? "photo" : "text",
      // The traveller's declared vehicle scopes the menu, and a board's heading
      // is where its vehicle is written - without both, a 155cc board's rows
      // all read as offers to someone who asked for 125cc.
      spec: {
        vehicleClass: rfq.vehicleClass === "car" ? "car" : rfq.vehicleClass,
        engineSizeCc: rfq.engineSizeCc,
        transmission: rfq.transmission,
      },
      headers: sectionHeaders(extractText || ""),
    });
    const fromModel = Array.isArray(extraction.options) ? extraction.options : [];
    const options = mergeOptions(fromModel, derived);
    if (options.length >= 2) extraction.options = options;
  }

  // TOTAL vs PER-DAY sanity net. Shops constantly quote the WHOLE rental
  // ("3 day 900 B" = 900 TOTAL = 300/day) and a mis-read here made the agent
  // "bargain" for MORE than the shop's real daily price - the worst possible
  // move. If the number is wildly above the area's typical daily price but
  // divides into a plausible daily price over the rental length, it was a
  // total: divide it. (The extraction prompt now rules this too; this is the
  // arithmetic backstop for when the model slips.)
  const floor = await floorPriceFor(ctx.region || undefined, rfq);
  let floorSameCur = floor && floor.currency === cur ? floor : null;
  if (usablePrice && rfq.durationDays > 1 && floorSameCur) {
    const typical = floorSameCur.typical ?? Math.round(floorSameCur.floor * 1.6);
    const perDayIfTotal = Math.round(usablePrice / rfq.durationDays);
    if (usablePrice >= typical * 2 && perDayIfTotal >= floorSameCur.floor * 0.55) {
      usablePrice = perDayIfTotal;
    }
  }
  // ...AND THE SAME NET ON THE OTHER SIDE. A number far BELOW the regional
  // floor is not a bargain, it is a misread - "Click 125cc 6 days discount
  // 250/1day" reached a traveller's card as ฿1/day. wa/rate-expr stops that
  // phrasing at the source; this stops the CLASS, because the next phrasing
  // will be different. A misread almost always sits beside the real number, so
  // the recovery is the cheapest believable amount from the SAME message, and
  // failing that, no price at all - which makes the agent ask instead of
  // bargaining up from something the shop never said.
  if (usablePrice && floorSameCur) {
    const { sanePrice } = await import("./wa/price-sanity");
    const { extractQuotedPrices } = await import("./wa/price-extract");
    const others = extractQuotedPrices(extractText || "", {
      vehicleClass: rfq.vehicleClass === "car" ? "car" : rfq.vehicleClass,
      durationDays: rfq.durationDays,
      localCurrency: cur,
    }).allOffers.map((h) => h.pricePerDay);
    const verdict = sanePrice(usablePrice, others, floorSameCur, {
      durationDays: rfq.durationDays,
    });
    if (verdict.corrected) {
      await sbInsert("agent_events", [
        {
          kind: "price-implausible",
          vendor_id: ctx.vendorId ?? "",
          vendor_name: ctx.vendorName ?? "",
          user_email: ctx.sender ?? "",
          detail: `${verdict.reason ?? ""} (${cur}, ${ctx.region ?? "?"})`.slice(0, 500),
        },
      ]).catch(() => {});
      usablePrice = verdict.pricePerDay ?? undefined;
      extraction.pricePerDay = verdict.pricePerDay ?? undefined;
      if (!verdict.pricePerDay) {
        extraction.found = false;
        extraction.confidence = "low";
      }
    }
  }
  // CREDIBILITY CLAMP (the Bargained-0 kill): a "floor" at/above the shop's
  // own live quote is bad data, not a reason to go mute - it used to flip
  // priceAtOrBelowFloor true and make the bargain edge illegal for EVERY shop
  // in the region (PH seed 350 vs live 300 quotes). Clamp below the quote so
  // the engine always has room to counter, and record the suspect data point.
  if (usablePrice && floorSameCur) {
    const credible = credibleFloor(floorSameCur.floor, usablePrice);
    if (credible.clamped && credible.floor) {
      await sbInsert("agent_events", [
        {
          kind: "suspect-floor",
          vendor_id: ctx.vendorId ?? "",
          vendor_name: ctx.vendorName ?? "",
          detail: `Market floor ${floorSameCur.floor} ${cur} >= live quote ${usablePrice} ${cur} (${ctx.region ?? "?"}) - clamped to ${credible.floor} so bargaining stays possible. Fix the floor data.`,
        },
      ]).catch(() => {});
      floorSameCur = { ...floorSameCur, floor: credible.floor };
    }
  }
  // DID WE READ THEIR PRICE BOARD RIGHT? Most shops answer with a photo, and
  // until now nothing ever checked the OCR - so the agent asked shops to retype
  // boards it had already read, and a misread number could be bargained from
  // for the rest of the thread. When a TYPED price lands on a thread where we
  // previously read a price off a photo, the two get compared and the verdict
  // is recorded. This is the source for the visionAccuracy KPI.
  if (images.length === 0 && usablePrice && ctx.vendorId && ctx.sender) {
    try {
      const prior = await sbSelect<{ price_per_day: number | null }>(
        "vendor_replies",
        `select=price_per_day&user_email=eq.${encodeURIComponent(
          ctx.sender
        )}&vendor_id=eq.${encodeURIComponent(
          ctx.vendorId
        )}&image_count=gt.0&price_per_day=not.is.null&order=created_at.desc&limit=1`
      );
      const sheet = prior[0]?.price_per_day ?? undefined;
      if (typeof sheet === "number" && sheet > 0) {
        const { reconcileVisionPrice } = await import("./vision-reconcile");
        const verdict = reconcileVisionPrice({
          sheetPricePerDay: sheet,
          textPricePerDay: usablePrice,
          durationDays: rfq.durationDays,
        });
        await sbInsert("agent_events", [
          {
            kind: "vision-check",
            vendor_id: ctx.vendorId,
            vendor_name: ctx.vendorName ?? "",
            user_email: ctx.sender,
            detail: JSON.stringify({
              agreement: verdict.agreement,
              sheet,
              text: usablePrice,
              deltaPct: verdict.deltaPct ?? null,
              note: verdict.detail,
            }).slice(0, 500),
          },
        ]).catch(() => {});
      }
    } catch {
      /* the reconciliation is telemetry - it must never break a turn */
    }
  }

  const replyBase = {
    user_email: ctx.sender ?? null,
    vendor_id: ctx.vendorId ?? "",
    vendor_name: ctx.vendorName ?? "",
    reply_text: text.slice(0, 4000),
    image_count: images.length,
    found: extraction.found,
    // The SANITY-CORRECTED per-day price (total quotes divided by days), so the
    // app never shows a 3-day total as a daily rate.
    price_per_day: usablePrice ?? extraction.pricePerDay ?? null,
    matches_spec: extraction.matchesSpec,
    confidence: extraction.confidence,
    auto: true,
  };
  // The shop's own money + confirmed conditions, so the app can show the real
  // local price and honest tags. sbInsert fails SILENTLY on an unknown column,
  // so if the owner has not run the newest schema yet we retry without the new
  // columns - a reply must NEVER vanish from the feed over a pending migration.
  const fullOk = await sbInsert("vendor_replies", [
    {
      ...replyBase,
      currency: cur,
      deposit: extraction.deposit ?? null,
      deposit_type: extraction.depositType ?? null,
      deposit_amount: extraction.depositAmount ?? null,
      deposit_currency: extraction.depositCurrency ?? null,
      delivers: extraction.delivers ?? null,
      insurance_included: extraction.insuranceIncluded ?? null,
      delivery_fee: extraction.deliveryFee ?? null,
    },
  ]);
  // Retry without the newest columns as the schema rolls out (silent-fail).
  if (!fullOk) {
    const okBasic = await sbInsert("vendor_replies", [
      { ...replyBase, currency: cur, deposit: extraction.deposit ?? null, delivers: extraction.delivers ?? null },
    ]);
    if (!okBasic) await sbInsert("vendor_replies", [replyBase]);
  }
  // Verified shop tags (item #13): record what this reply explicitly stated.
  // A tag only ever SHOWS after >= 2 distinct replies confirm it.
  if (ctx.vendorId) {
    const { tagsFromExtraction, recordTagSignals } = await import("./vendor-tags");
    await recordTagSignals(
      ctx.vendorId,
      ctx.sender ?? undefined,
      text,
      tagsFromExtraction(extraction, text)
    ).catch(() => {});
  }
  // Only a price for the EXACT requested vehicle becomes an OFFER (best-price
  // card, deals dashboard, market-rate warehouse). A price the shop quoted for a
  // DIFFERENT vehicle (matchesSpec === false - e.g. an e-bike when a 125cc
  // scooter was asked) is NOT the traveller's offer: presenting it as the
  // cheapest/lockable price misleads the user, and filing it under the requested
  // vehicle_key would poison the market rate. It stays in vendor_replies (so the
  // reply is still visible and the agent can clarify), but never an offers row.
  if (usablePrice && extraction.matchesSpec !== false) {
    // Tag the offer with area + vehicle bucket + a delivery signal, so the
    // owner's shop-intelligence warehouse can aggregate real market data.
    const { vehicleKeyFor, regionKeysFor } = await import("./market");
    const regionKey = regionKeysFor(ctx.region || undefined)[0] ?? null;
    const vehicleKey = vehicleKeyFor(rfq);
    // Prefer the AI's explicit read; fall back to a conservative text signal.
    const delivers =
      extraction.delivers ??
      (/\b(deliver|drop off|bring it|to your hotel|free delivery)\b/i.test(text) ? true : null);
    const offerBase = {
      user_email: ctx.sender ?? null,
      vendor_id: ctx.vendorId ?? "",
      vendor_name: ctx.vendorName ?? "",
      price_per_day: usablePrice,
      // The shop's OWN starting price, so the discount we won is measurable.
      // This was set to usablePrice, which made list === paid on every row and
      // pinned the bargain-margin KPI at 0% no matter how well the agent did.
      // The real list price is the restated regular price when the shop gave
      // one, else the priciest tier it offered, else the current price.
      list_price_per_day:
        extraction.listPricePerDay ??
        (extraction.options?.length
          ? Math.max(...extraction.options.map((o) => o.pricePerDay))
          : undefined) ??
        usablePrice,
      currency: cur,
      round,
      simulated: false,
      verified: isVerified(),
      region_key: regionKey,
      vehicle_key: vehicleKey,
      duration_days: rfq.durationDays ?? null,
      delivers,
    };
    // Session attribution for exact rival grouping (analytics + deals).
    let searchId: number | null = null;
    if (ctx.sender) {
      const s = await sbSelect<{ id: number }>(
        "searches",
        `select=id&user_email=eq.${encodeURIComponent(ctx.sender)}&order=created_at.desc&limit=1`
      ).catch(() => []);
      searchId = s[0]?.id ?? null;
    }
    // Retry without the newest columns if the migration has not run yet.
    const offerOk = await sbInsert("offers", [
      {
        ...offerBase,
        search_id: searchId,
        deposit_note: extraction.deposit ?? null,
        deposit_type: extraction.depositType ?? null,
        deposit_amount: extraction.depositAmount ?? null,
        deposit_currency: extraction.depositCurrency ?? null,
        delivery_fee: extraction.deliveryFee ?? null,
        insurance_included: extraction.insuranceIncluded ?? null,
        km_limit_per_day: extraction.kmLimitPerDay != null ? String(extraction.kmLimitPerDay) : null,
        fuel_policy: extraction.fuelPolicy ?? null,
      },
    ]);
    if (!offerOk) {
      const okDep = await sbInsert("offers", [{ ...offerBase, deposit_note: extraction.deposit ?? null }]);
      if (!okDep) await sbInsert("offers", [offerBase]);
    }
    // HOT-STATE WRITE-THROUGH (Module 2): mirror the offer into the Redis
    // session aggregates (lowest-rival ZSET + OFFERS IN / BARGAINED HSET) and
    // publish the delta for the SSE stream. REDIS_URL-gated no-op when unset;
    // never throws; Postgres above remains the source of truth.
    if (searchId != null) {
      const { recordSessionOffer } = await import("./rival-cache");
      await recordSessionOffer({
        searchId,
        vendorId: ctx.vendorId ?? "",
        vehicleKey,
        currency: cur,
        pricePerDay: usablePrice,
        // First write pins the list anchor; later rounds only lower the score.
        listPricePerDay: usablePrice,
        durationDays: rfq.durationDays ?? 1,
      }).catch(() => {});
    }
  }

  // Web Push: alert the traveller a shop replied even if the app is CLOSED, so
  // they can leave the app and come back. Fire-and-forget; no-op without VAPID.
  // COLLAPSED per shop (the duplicate-notification fix): a 3-message burst from
  // one shop = ONE push. A price landing is important and bypasses the collapse.
  //
  // ...AND ONLY WHEN IT IS WORTH THE INTERRUPTION. The collapse window answers
  // "how often"; it cannot answer "whether", and a hunt contacts a dozen shops
  // that mostly answer with an opening-hours auto-reply. Fifteen different
  // shops are fifteen different collapse keys, so the traveller got fifteen
  // buzzes carrying nothing they could act on. lib/notify/significance judges
  // what an event CHANGES for them - a first price, a new best price, the
  // moment the hunt comes alive - and everything else stays in the app, where
  // it is still perfectly visible.
  if (ctx.sender) {
    await finishBeforeResponse("reply-push", async () => {
      try {
        const { classifyReply, worthAnInterruption } = await import("./notify/significance");
        const { notifyState, markPushSent } = await import("./notify/state");
        // WITH THE VENDOR, so "this shop came down from 250" is a fact the
        // gate can see. Without it, a shop moving while another sits cheaper
        // produced nothing at all.
        const state = await notifyState(ctx.sender!, Date.now(), ctx.vendorId);
        const { classifyActs } = await import("./wa/dialogue-acts");
        const acts = classifyActs({ text, pricePerDay: usablePrice ?? null });
        const event = classifyReply({
          pricePerDay: usablePrice,
          currency: cur,
          anyReplyYet: state.anyReplyYet,
          termsLanded: acts.shared.includes("deposit"),
        });
        const verdict = worthAnInterruption(event, state);
        if (!verdict.notify) return;

        const shop = ctx.vendorName || "A rental shop";
        const body = usablePrice
          ? `${shop} offered ${usablePrice} ${cur}/day - tap to see the deal.`
          : `${shop} answered - your hunt is live.`;
        const m = await import("./push");
        await m.sendPushCollapsed(
          ctx.sender!,
          `reply:${ctx.vendorId || from}`,
          {
            title: usablePrice ? "New price 💰" : "Your hunt is live 🛵",
            body,
            // A DESTINATION, NOT JUST A BUZZ. Every push in the app pointed at
            // "/" - so a tap after the app had been killed landed on a cold
            // home screen with the thread nowhere in sight. The id is enough
            // for the app to restore the hunt and open this shop.
            url: ctx.vendorId ? `/?shop=${encodeURIComponent(ctx.vendorId)}` : "/",
            // SAME TAG AS THE INGEST BUZZ. This push is an UPGRADE of "the shop
            // replied" that already fired the moment the message landed, so it
            // must replace it on the lock screen instead of adding a second
            // buzz for the same event.
            tag: `shop:${from}`,
          },
          { windowSec: 180, important: Boolean(usablePrice) }
        );
        await markPushSent(ctx.sender!, `${event.kind}: ${verdict.reason}`);
      } catch {
        /* a notification is never worth breaking the reply loop for */
      }
    });
  }

  // INBOUND GLOSS (fire-and-forget): translate a local-language shop reply to
  // English and stamp it on the stored inbound row (raw.english), so every
  // surface (card peek, transcript) shows the translation under the original.
  // The traveller must always understand the conversation their agent is
  // having - that IS the product.
  if (ctx.sender && text) {
    await finishBeforeResponse("inbound-gloss", async () => {
      try {
        const { translateToEnglish } = await import("./agents");
        const english = await translateToEnglish(text);
        if (!english) return;
        // PRIVACY: the no-id fallback is receiver-scoped, so the gloss can
        // never be stamped onto ANOTHER user's inbound row with these digits.
        const receiverScope = ctx.sender
          ? `&raw->>receiver=eq.${encodeURIComponent(ctx.sender)}`
          : "";
        const rows = await sbSelect<{ id: number; raw: Record<string, unknown> | null }>(
          "whatsapp_messages",
          opts.waMessageId
            ? `select=id,raw&direction=eq.inbound&wa_message_id=eq.${encodeURIComponent(
                opts.waMessageId
              )}&limit=1`
            : `select=id,raw&direction=eq.inbound${receiverScope}&order=received_at.desc&limit=1${numberFilter(
                "from_number",
                from
              )}`
        );
        const row = rows[0];
        if (row) {
          // Merge preserves receiver/instance - the scoping keys must survive.
          await sbUpdate("whatsapp_messages", `id=eq.${row.id}`, {
            raw: { ...(row.raw ?? {}), english },
          });
        }
      } catch {
        /* gloss is an enhancement - never blocks the loop */
      }
    });
  }

  // THE READING, STORED BESIDE THE PICTURE IT CAME FROM.
  //
  // The vision agent already read this board; until now that reading became an
  // offer and then evaporated, so the image and the understanding of the image
  // lived in two different places and only one was ever shown. A traveller
  // looking at a price under a photo had no way to tell whether we read the
  // board or guessed - and when we get one wrong there was nothing to point at.
  //
  // Stamped onto the message's own `raw` (JSON - no column, no migration), so
  // the transcript can render exactly what was understood, per photo.
  //
  // The reading is computed HERE (it is pure) and kept in scope, so the turn
  // that follows can stamp what it actually DID about the photo onto the same
  // artefact - see `recordMediaFollowUp` below. Writing the whole object again
  // rather than patching it also makes the two writes order-independent.
  let mediaReading: import("./media/reading").MediaReading | null = null;
  const stampMediaReading = async (reading: import("./media/reading").MediaReading) => {
    try {
      const receiverScope = `&raw->>receiver=eq.${encodeURIComponent(ctx.sender!)}`;
      const rows = await sbSelect<{ id: number; raw: Record<string, unknown> | null }>(
        "whatsapp_messages",
        opts.waMessageId
          ? `select=id,raw&direction=eq.inbound&wa_message_id=eq.${encodeURIComponent(
              opts.waMessageId
            )}&limit=1`
          : `select=id,raw&direction=eq.inbound${receiverScope}&order=received_at.desc&limit=1${numberFilter(
              "from_number",
              from
            )}`
      );
      const row = rows[0];
      if (row) {
        await sbUpdate("whatsapp_messages", `id=eq.${row.id}`, {
          raw: { ...(row.raw ?? {}), reading },
        });
        return;
      }
      // NO ROW TO STAMP is itself the bug we spent a field test chasing. An
      // empty catch made a missing summary indistinguishable from a summary
      // nobody looked for; the trace makes it a thing the doctor can show.
      await sbInsert("agent_events", [
        {
          kind: "reading-stamp-failed",
          vendor_id: ctx.vendorId ?? "",
          vendor_name: ctx.vendorName ?? "",
          detail: `no inbound row matched (waMessageId=${opts.waMessageId ?? "none"})`.slice(0, 500),
        },
      ]).catch(() => {});
    } catch (e) {
      // The summary is a proof surface - it never blocks the reply, but it
      // never disappears silently either.
      await sbInsert("agent_events", [
        {
          kind: "reading-stamp-failed",
          vendor_id: ctx.vendorId ?? "",
          vendor_name: ctx.vendorName ?? "",
          detail: (e instanceof Error ? e.message : "stamp threw").slice(0, 500),
        },
      ]).catch(() => {});
    }
  };
  /** Record the move this turn took on the media, so the panel can stop guessing. */
  const recordMediaFollowUp = (
    move: string,
    delivered: import("./media/reading").ReadingFollowUp["delivered"]
  ) => {
    if (!mediaReading) return;
    mediaReading = { ...mediaReading, followUp: { move, delivered, at: new Date().toISOString() } };
    void stampMediaReading(mediaReading);
  };

  // THE TURN THAT LOOKED IS NOT ALWAYS THE TURN THAT HOLDS THE BYTES.
  //
  // This gate used to be `images.length > 0`, which is true only on the inline
  // path. In production the vision Flow reads the photo in an isolated worker
  // and the CONTINUATION composes the reply - calling this function with
  // `images: []` and the finished extraction in `preExtracted`. So on the path
  // every real traveller is served by, the stamp never ran: the photo rendered
  // in the conversation and the agent's summary under it never existed. The
  // question the gate must ask is "does this turn HOLD a reading of media?",
  // and the extraction answers that whether or not the bytes came with it.
  const { holdsMediaReading: turnHoldsMedia } = await import("./media/reading");
  if (turnHoldsMedia(images.length, extraction as never) && ctx.sender) {
    const { readingFrom } = await import("./media/reading");
    mediaReading = readingFrom(extraction as never, {
      usedPricePerDay: usablePrice,
      notUsedReason: usablePrice
        ? undefined
        : extraction.found === false
          ? "No usable price in this image."
          : undefined,
    });
    void stampMediaReading(mediaReading);

    // AN OUTAGE IS AN EVENT, NOT A READING. When no provider ever looked at the
    // photo the Ops feed gets told so by name - previously the only trace was a
    // per-instance diagnostics array nobody read, and the traveller was shown a
    // confident "nothing readable in this one" about an image nobody had seen.
    if (extraction.imageRead?.seen === false) {
      void sbInsert("agent_events", [
        {
          kind: "vision-unavailable",
          vendor_id: ctx.vendorId ?? "",
          vendor_name: ctx.vendorName ?? "",
          detail: `${extraction.imageRead.failure ?? "unknown"}${
            extraction.imageRead.retryable ? " (retryable)" : ""
          }: ${extraction.imageRead.detail ?? ""}`.slice(0, 500),
        },
      ]).catch(() => {});
    }
  }

  // HUMAN TAKEOVER GATE (pre-engine): the user typed in this shop's thread
  // themselves - the agents stand down for THIS thread until handback. The
  // reply was stored and pushed above; we just don't answer it.
  if (ctx.sender && !sessionClosed) {
    try {
      const { isThreadTakenOver } = await import("./session-flags");
      // Fail CLOSED: skip the auto-reply on true (taken over) OR null (store
      // unreadable) - talking over a human is an absolute-veto violation, so an
      // unknown state must not proceed. The inbound is already stored/pushed;
      // only the automated answer is withheld, and it resumes once readable.
      const takeover = await isThreadTakenOver(ctx.sender, from);
      if (takeover !== false) {
        // Distinguish a genuine takeover from an unreadable store (which also
        // fails closed): a Supabase blip silently muting every reply is exactly
        // the kind of failure this trace surfaces.
        void noteInboundDropped(opts.senderEmail, from, "takeover-hold", {
          state: takeover === true ? "taken-over" : "unreadable",
        });
        return;
      }
    } catch {
      void noteInboundDropped(opts.senderEmail, from, "takeover-hold", { state: "error" });
      return; // unreadable -> fail closed (do not auto-reply)
    }
  }

  // SESSION PAUSE GATE (pre-engine, same philosophy as sessionClosed): the
  // user told Will to hold everything. The reply was stored and the push sent
  // above - the agents just say NOTHING until the user resumes.
  if (ctx.sender && !sessionClosed) {
    try {
      const { isSessionPaused } = await import("./session-flags");
      // Fail CLOSED on true (paused) OR null (unreadable): "hold everything" is
      // absolute, so an unknown pause state withholds the auto-reply.
      const paused = await isSessionPaused(ctx.sender);
      if (paused !== false) {
        void noteInboundDropped(opts.senderEmail, from, "pause-hold", {
          state: paused === true ? "paused" : "unreadable",
        });
        return;
      }
    } catch {
      void noteInboundDropped(opts.senderEmail, from, "pause-hold", { state: "error" });
      return; // unreadable -> fail closed
    }
  }

  // SESSION TERMINATED GATE (HARD). A closed / deal-closed session must never
  // keep talking to shops - this was the "agents replied overnight after I
  // cleared the search" bug. It used to be only a SOFT director fact the LLM
  // could override; now it is an absolute stop. The reply is already stored
  // above (data is never lost); the agent simply says nothing more. A new
  // search re-opens the shop with a fresh RFQ that postdates the marker.
  if (sessionClosed) {
    void noteInboundDropped(opts.senderEmail, from, "session-terminated");
    return;
  }

  // ==== THE DIGRAPH NEGOTIATION ENGINE (v2) ==================================
  // The default path: a true directed graph of specialized agents driven by a
  // chief Negotiation Director (multi-round bargaining, deposit + fulfillment
  // probing, strategic waits, media coherence, judge scoring). The legacy
  // inline pipeline below is kept behind GRAPH_ENGINE=off for one release.
  // Resolve the traveller's consented stay FRESH from their profile at turn time
  // (never the frozen outbound meta), so once they add their hotel the very next
  // shop message is answered with it - the delivery-loop fix.
  if (ctx.sender) {
    try {
      const { getUserStay } = await import("./access");
      const stay = await getUserStay(ctx.sender);
      if (stay) (ctx as ThreadContext).stay = stay;
    } catch {
      /* no stay resolvable -> the loop-stop branch prompts the user */
    }
  }

  const { liveGraphIO } = await import("./graph/engine");
  const { threadKeyFor } = await import("./graph/state");
  const eventKind: "inbound-text" | "inbound-image" =
    images.length > 0 ? "inbound-image" : "inbound-text";
  // The ONE input both engines share, so the V3 -> graph fallback is behaviour-
  // identical at the boundary (same context, same IO, same deadline).
  const turnInput: import("./graph/types").GraphTurnInput = {
    event: {
      kind: eventKind,
      threadKey: threadKeyFor(ctx.sender ?? undefined, from),
      userEmail: ctx.sender ?? undefined,
      toDigits: from,
      // The coalesced unread buffer, so the director/answer nodes see the
      // shop's full recent burst (question + vehicle + price together).
      shopMessage: extractText,
      images,
      audios: [],
    },
    // WHAT THIS TURN IS ANSWERING. Threaded so every engine can stamp its
    // parked draft with it, and the drain can refuse a reply the shop has
    // already moved past (wa/freshness.ts).
    ctx: { ...ctx, inboundId: opts.waMessageId },
    rfq,
    extraction,
    usablePrice,
    currency: cur,
    floorPrice: floorSameCur?.floor,
    floorTypical: floorSameCur?.typical ?? undefined,
    sessionClosed,
    history,
    priorOutbound: thread
      .filter((m) => m.direction === "outbound")
      .map((m) => m.body ?? "")
      .filter(Boolean),
    priorInbound: thread
      .filter((m) => m.direction === "inbound")
      .map((m) => m.body ?? "")
      .filter(Boolean),
    legacyCounts: {
      clarify: autoClarifies,
      bargain: autoBargains,
      answer: autoAnswers,
      close: autoCloses,
    },
    humanDelay: Boolean(opts.humanDelay && ctx.sender),
    transcript: opts.transcript ?? null,
    deadlineAt: Date.now() + 45_000,
  };
  const io = liveGraphIO(opts.send);

  // ENGINE_V3 (SPTE - Shared Session Blackboard + single-pass) is the PRIMARY
  // negotiation engine. ZERO-DOWNTIME FALLBACK: runSpteLiveTurn only ever throws
  // from its pre-send context build (never after a message leaves), so on ANY
  // error we log the telemetry and fail over to the repaired graph engine
  // WITHOUT dropping or double-sending the reply.
  // ONE routing authority, shared with the wakeup drain (engine-route.ts), so
  // an inbound reply and a scheduled follow-up on the same thread can never be
  // answered by different engines with different rules.
  const { runThreadTurn } = await import("./engine-route");
  const routed = await runThreadTurn(turnInput, io, "inbound");
  if (routed.engine !== "none") {
    // WHAT WE ACTUALLY DID ABOUT THE PHOTO, written next to the photo. The
    // proof panel renders this; with nothing recorded it now claims nothing.
    if (routed.spte) recordMediaFollowUp(routed.spte.move, routed.spte.delivered);
    // WHAT THE SHOP SAID ABOUT EACH EXTRA THE TRAVELLER ASKED FOR.
    //
    // The request - helmets, a phone mount, delivery - left the app in the
    // opening message and never came back, so the booking screen could show a
    // helmet the shop had already refused. Read AFTER the reply has gone, so
    // it never sits on the path between a shop's message and our answer, and
    // only when there is actually something to read: no requested extras, no
    // call. Awaited rather than detached, because Cloud Run freezes the CPU
    // the moment the response flushes.
    if (rfq?.accessories?.length && ctx.sender && ctx.vendorId) {
      const email = ctx.sender;
      const vendorId = ctx.vendorId;
      const inboundText = opts.text ?? "";
      await finishBeforeResponse("accessory-verdicts", async () => {
        const { recordAccessoryVerdicts, persistAccessoryStatus } = await import(
          "./thread/accessory-pass"
        );
        const { verdicts } = await recordAccessoryVerdicts({
          email,
          vendorId,
          requested: rfq.accessories,
          inboundText,
        });
        if (verdicts)
          await persistAccessoryStatus({
            email,
            vendorId,
            requested: rfq.accessories,
            verdicts,
          });
      });
    }
    // The turn reached an engine and produced its own outcome (sent, held or
    // deliberately silent). The message is CONSUMED either way - keeping the
    // claim is what stops an endless redelivery loop; releasing it is only
    // for turns that never got this far.
    turnDelivered = true;
    return;
  }

  // ==== THE LEGACY ORCHESTRATOR PIPELINE (GRAPH_ENGINE=off) ===================
  // Stage order per reply: extract (done above) -> deterministic discipline
  // ladder (what is ALLOWED) -> strategist (session-wide thinking + timing) ->
  // drafting agent (reply/price) -> validator (critique/revise) -> localize ->
  // deliver. Every stage writes a trace row; with no AI key every stage
  // degrades to the deterministic behavior.
  const {
    getOrchestratorConfig,
    runStrategist,
    validateDraft,
    sessionDigestFor,
    ownerDirectives,
    registerRules,
    stripGreeting,
    newDecisionId,
    writeTrace,
  } = await import("./orchestrator");
  const cfg = await getOrchestratorConfig();
  const decisionId = newDecisionId();
  const traces: TraceRow[] = [];
  const traceBase = {
    decisionId,
    userEmail: ctx.sender ?? undefined,
    vendorId: ctx.vendorId ?? undefined,
    vendorName: ctx.vendorName ?? undefined,
  };
  traces.push({
    ...traceBase,
    stage: "extract",
    input: text.slice(0, 600) || "(price-list photo)",
    reasoning: `found=${extraction.found} matchesSpec=${extraction.matchesSpec} confidence=${extraction.confidence}`,
    output: usablePrice ? `${usablePrice} ${cur}/day` : "(no usable price)",
  });

  // ---- Negotiation numbers: pure inputs to the branching engine -------------
  // These are computed here (they need the DB for cross-shop leverage) and fed
  // to the pure decide() engine as plain booleans, so the DECISION itself is
  // fully owner-editable and testable.
  const floorPrice: number | undefined = floorSameCur?.floor;
  const priceAtOrBelowFloor = Boolean(usablePrice && floorPrice && usablePrice <= floorPrice * 1.05);
  let rivalPrice: number | undefined;
  let target: number | undefined;
  if (usablePrice && !priceAtOrBelowFloor && extraction.matchesSpec !== false && autoBargains === 0) {
    // CROSS-SHOP LEVERAGE (same search session): a lower real offer from
    // another shop is honest negotiating power.
    if (ctx.sender) {
      const { vehicleKeyFor } = await import("./market");
      const { cheapestRivalFor } = await import("./search-session");
      rivalPrice = await cheapestRivalFor(ctx.sender, {
        vendorId: ctx.vendorId ?? "",
        currency: cur,
        vehicleKey: vehicleKeyFor(rfq),
        belowPrice: usablePrice,
      }).catch(() => undefined);
    }
    const baseTarget = floorPrice
      ? Math.max(floorPrice, Math.round(usablePrice * 0.6))
      : Math.round(usablePrice * 0.85);
    target = rivalPrice
      ? Math.max(floorPrice ?? 0, Math.min(baseTarget, rivalPrice))
      : baseTarget;
  }
  const targetIsRealSaving = Boolean(usablePrice && target && target < usablePrice * 0.95);

  // ---- The branching engine decides the ALLOWED move (never composes text) --
  const { decide } = await import("./branching");
  const { getDecisionGraph } = await import("./orchestrator");
  const graph = await getDecisionGraph();
  const decisionCtx = {
    sessionClosed,
    shopAskedQuestion: shopAskedQuestion(text),
    shopSentVehiclePhoto: extraction.imageKind === "vehicle",
    hasUsablePrice: Boolean(usablePrice),
    verified: isVerified(),
    hasClarifyMessage: Boolean(extraction.clarifyMessage),
    matchesSpecNotFalse: extraction.matchesSpec !== false,
    priceAtOrBelowFloor,
    targetIsRealSaving,
    rivalCheaper: Boolean(rivalPrice),
    counts: {
      clarify: autoClarifies,
      bargain: autoBargains,
      answer: autoAnswers,
      close: autoCloses,
    },
  };
  const decision = decide(decisionCtx, graph);
  const direction = decision.direction;
  const ladderWhy = decision.why;

  // Deterministic post-decision details the engine intentionally leaves out:
  // the close copy (warm-yes vs polite-no) and the round bump.
  let closeVariants = CLOSE_OK;
  let nextRound = round;
  if (direction === "bargain") {
    nextRound = 1;
  } else if (direction === "close" && autoBargains >= 1) {
    // A close that FOLLOWS our single ask: match the shop's answer's tone.
    nextRound = round + 1;
    const saidYes =
      usablePrice !== undefined ||
      /\b(ok|okay|yes|sure|deal|can do|no problem)\b/i.test(text);
    closeVariants = saidYes ? CLOSE_OK : CLOSE_NO;
  }
  traces.push({
    ...traceBase,
    stage: "discipline",
    input: `counters: clarifies=${autoClarifies} bargains=${autoBargains} answers=${autoAnswers} closes=${autoCloses} sessionClosed=${sessionClosed}`,
    reasoning: `rule: ${decision.ruleId ?? "default"} - ${ladderWhy}`,
    output: direction,
  });

  // ---- Strategist: the whole search session + reply timing ------------------
  const sessionDigest = ctx.sender
    ? await sessionDigestFor(ctx.sender, ctx.vendorId).catch(() => "")
    : "";
  const strat = await runStrategist({
    cfg,
    history,
    sessionDigest,
    shopMessage: text,
    ladderDirection: direction,
    quotedPerDay: usablePrice,
    targetPerDay: target,
    rivalPerDay: rivalPrice,
    currency: cur,
  });
  traces.push({
    ...traceBase,
    stage: "strategist",
    input: sessionDigest || "(only this shop in session)",
    reasoning: strat.reasoning,
    output:
      strat.action + (strat.waitSeconds ? ` ${strat.waitSeconds}s` : "") +
      (strat.leverageNote ? ` | leverage: ${strat.leverageNote}` : ""),
    verdict: strat.fromAi ? undefined : "deterministic",
  });
  if (strat.action === "silent" || direction === "silent") {
    await writeTrace(traces);
    return;
  }

  // ---- Drafting agent (reply / price) ---------------------------------------
  let followUp: string | null = null;
  let followKind: string = direction;
  let englishGloss: string | undefined;
  // LANGUAGE ADAPTATION: a shop writing real English gets English back for
  // this reply - matching the human beats the local-language setting.
  const { looksEnglish } = await import("./agents");
  const useLocalLang =
    Boolean(ctx.localLang) && ctx.plan === "ultra" && !looksEnglish(text);
  const register = registerRules(cfg, cur, ctx.region || undefined);

  if (direction === "answer") {
    const { chat } = await import("./ai");
    const spec = fallbackAnswer(rfq);
    // A photo of the actual VEHICLE (not a price sheet) is not a question - it
    // is the shop showing off the ride. Thank them warmly and keep the door open.
    const vehiclePhoto = extraction.imageKind === "vehicle" && !shopAskedQuestion(text);
    if (vehiclePhoto) {
      const veh =
        rfq.vehicleClass === "car" ? "car" : rfq.vehicleClass === "scooter" ? "scooter" : "bike";
      const thanksFallback = `Thanks for the photo, the ${veh} looks great! Could you confirm your best daily price for it?`;
      const llm = await chat([
        {
          role: "system",
          content:
            "You are the traveller in a WhatsApp chat with a vehicle rental shop. " +
            "The shop just sent a PHOTO of the actual vehicle (not a price list). " +
            "Reply in ONE short, warm, casual sentence (max 25 words): thank them for " +
            "the photo and, only if we do not already have a price for our exact " +
            "vehicle, gently ask their best daily price. " +
            "You are MID-CONVERSATION: never greet again. NEVER accept a deal or " +
            "confirm a booking - only the traveller decides. " +
            (register ? register + " " : "") +
            ownerDirectives(cfg, "reply") +
            " Reply with the message text only.",
        },
        { role: "user", content: `Conversation so far:\n${history}\n\nThe shop sent a photo of the ${veh}.` },
      ]);
      followUp = (llm ?? "").trim().slice(0, 300) || thanksFallback;
    } else {
      const llm = await chat([
        {
          role: "system",
          content:
            "You are the traveller in a WhatsApp chat with a vehicle rental shop. " +
            "The shop just asked a question. Answer ONLY that question in ONE short, " +
            "casual, friendly sentence (max 25 words), strictly using these facts - " +
            `never invent anything: ${spec} ` +
            "You are MID-CONVERSATION: never greet again (no hey/hi/hello). " +
            "Do not re-ask for the price if the shop already gave one for our exact vehicle. " +
            "HARD RULE: NEVER accept a deal, never confirm a booking, never say a price " +
            "'works' - only the traveller decides that. If the shop is asking whether we " +
            "take their offer, say you will think it over and get back to them. " +
            (register ? register + " " : "") +
            ownerDirectives(cfg, "reply") +
            " Reply with the message text only.",
        },
        { role: "user", content: `Conversation so far:\n${history}\n\nShop's question: ${text}` },
      ]);
      followUp = (llm ?? "").trim().slice(0, 300) || spec;
    }
  } else if (direction === "clarify") {
    followUp = extraction.clarifyMessage ?? null;
  } else if (direction === "close") {
    followUp = closeVariants[Math.floor(Math.random() * closeVariants.length)];
  } else if (direction === "bargain" && usablePrice && target) {
    const draft = await composeBargain({
      rfq,
      vendor: { name: ctx.vendorName ?? "the shop" } as Vendor,
      currentPricePerDay: usablePrice,
      rivalPricePerDay: rivalPrice,
      region: ctx.region || undefined,
      // The REAL round (0-based). A hardcoded 1 framed the first-ever counter as
      // a "SECOND PUSH" that falsely implies the shop already refused an ask -
      // so the opener's days-leverage play never fired on first contact.
      round: autoBargains,
      currency: cur,
      localLanguage: useLocalLang,
      targetPricePerDay: target,
      floorPricePerDay: floorPrice,
      history,
      voiceKey: ctx.sender ?? undefined,
      // The strategist's leverageNote is LLM-authored free text. NEVER pass it
      // as licensed leverage when it asserts a competitor PRICE that is not our
      // one server-verified rival - that is exactly how an invented "another
      // shop offered 220" gets laundered into the message. A real rival is
      // force-injected by composeBargain via rivalPricePerDay; the note may only
      // carry NON-price strategic hints ("shop sounds flexible", "low season").
      extraDirectives: [
        register,
        ownerDirectives(cfg, "price"),
        safeLeverageNote(strat.leverageNote, rivalPrice),
        // Module 4: deterministic per-turn structural shape (sentence order,
        // contractions, emoji rule) so no two turns share a skeleton.
        (await import("./copy/promptCompiler")).compileStyleDirectives(
          { threadId: `${ctx.sender ?? ""}:${from}`, vendorId: ctx.vendorId ?? "", nonce: autoBargains },
          ctx.region || undefined
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    });
    followUp = draft.message;
    if (useLocalLang && draft.english) englishGloss = draft.english;
    await sbInsert("bargain_drafts", [
      {
        user_email: ctx.sender ?? null,
        vendor_id: ctx.vendorId ?? "",
        tactic: draft.tacticId,
        message: draft.message,
      },
    ]);
  }
  traces.push({
    ...traceBase,
    stage: direction === "bargain" ? "price-agent" : "reply-agent",
    input: `direction=${direction}${target ? ` target=${target} ${cur}` : ""}${rivalPrice ? ` rival=${rivalPrice}` : ""}`,
    reasoning: ladderWhy,
    output: followUp ?? "(no draft)",
  });
  if (!followUp) {
    await writeTrace(traces);
    return;
  }

  // ---- Validator: critique + revise before anything sends -------------------
  const priorOutbound = thread
    .filter((m) => m.direction === "outbound")
    .map((m) => m.body ?? "")
    .filter(Boolean);
  // Mid-thread messages never greet again (deterministic, runs even with AI).
  if (priorOutbound.length > 0) followUp = stripGreeting(followUp);
  // Localized bargains are validated deterministically only (an English
  // critique pass on Thai text risks flipping the language - stickiness wins).
  const skipAiValidation = direction === "bargain" && useLocalLang;
  const validation = await validateDraft({
    cfg: skipAiValidation
      ? { ...cfg, stages: cfg.stages.map((s) => (s.id === "validator" ? { ...s, enabled: false } : s)) }
      : cfg,
    history,
    draft: followUp,
    shopMessage: text,
    priorOutbound,
    currency: cur,
  });
  traces.push({
    ...traceBase,
    stage: "validator",
    input: followUp,
    reasoning: validation.reasons.join("; ") || "clean",
    output: validation.verdict === "veto" ? "(vetoed)" : validation.text,
    verdict: validation.verdict,
  });
  if (validation.verdict === "veto" || !validation.text) {
    await writeTrace(traces);
    return;
  }
  followUp = validation.text;

  // ---- NEGOTIATION INTEGRITY (deterministic, the legacy path's missing gate) -
  // The graph engine (default) runs checkOutboundNumbers + a duration guard on
  // every outbound; the legacy pipeline (GRAPH_ENGINE=off) shipped whatever the
  // LLM wrote. That is how a hallucinated "another shop quoted 220" and a wrong
  // "3 days" (search was 5) reached a real shop. Mirror the engine's gate here.
  // Only English drafts are validated numerically (a localized bargain is Thai
  // etc.; its levers were preserved at compose time and a strip would corrupt it).
  if (followUp && !(useLocalLang && followKind === "bargain")) {
    // (a) DURATION: rewrite any wrong rental length to the real duration.
    const dur = correctDuration(followUp, rfq.durationDays);
    if (dur.changed) {
      traces.push({
        ...traceBase,
        stage: "integrity",
        input: followUp,
        reasoning: `duration guard: draft said ${dur.from.join("/")} day(s), traveller's rental is ${rfq.durationDays} - corrected`,
        output: dur.text,
        verdict: "revised",
      });
      followUp = dur.text;
      if (englishGloss) englishGloss = undefined;
    }
    // (b) NUMERIC SANITY: fabricated rival (all directions) + sub-floor /
    // inverted-ask bounds (bargain only). rivalPrice is a SERVER-VERIFIED
    // same-session offer - the only thing that licenses a rival claim.
    const isBargain = followKind === "bargain";
    const excludeExact = [rfq.durationDays, rfq.engineSizeCc, rfq.seats].filter(
      (n): n is number => typeof n === "number"
    );
    const numCheck = checkOutboundNumbers({
      text: followUp,
      ceiling: isBargain ? usablePrice : undefined,
      floor: isBargain ? floorPrice : undefined,
      rivalPrice,
      excludeExact,
      // PROVENANCE: the numbers this thread actually holds. A draft numeral
      // must be one of these or a closed derivation (total/days, daily*days,
      // rounding) - the field's invented "Your price 300 is too much" had no
      // path here and dies; a derived "200/day" from "1200 for 6 days" lives.
      grounded: [
        usablePrice,
        target,
        floorPrice,
        extraction.pricePerDay,
        ...(extraction.options ?? []).map((o) => o.pricePerDay),
        // Every numeral the conversation verbatim contains, both directions -
        // a number either party already said is never an invention.
        ...verbatimNumerals([text, ...thread.map((m) => m.body ?? "")]),
      ].filter((n): n is number => typeof n === "number" && n > 0),
      durationDays: rfq.durationDays,
      checkAskBounds: isBargain,
    });
    if (!numCheck.ok) {
      const safe = isBargain
        ? buildSafeBargainAsk({
            target,
            ceiling: usablePrice,
            floor: floorPrice,
            durationDays: rfq.durationDays,
            currency: cur,
            money,
          })
        : stripRivalClaims(followUp);
      traces.push({
        ...traceBase,
        stage: "integrity",
        input: followUp,
        reasoning: `numeric guard (${numCheck.violation}): ${numCheck.detail} - ${
          safe ? "repaired to a safe, rival-free message" : "no honest repair - suppressing this send"
        }`,
        output: safe ?? "(suppressed)",
        verdict: safe ? "revised" : "veto",
      });
      if (!safe) {
        await writeTrace(traces);
        return; // never ship a lie; the next inbound recomposes cleanly
      }
      followUp = safe;
      if (englishGloss) englishGloss = undefined;
    }
  }

  // LANGUAGE STICKINESS: a thread that started in the shop's local language
  // NEVER flips to English mid-conversation (the "agent suddenly switched to
  // English" bug). Bargains come localized from composeBargain already; the
  // clarify / answer / close paths are localized here, keeping the faithful
  // English gloss for the traveller. Street register applies (orchestrator).
  if (followUp && useLocalLang && followKind !== "bargain") {
    const { localizeMessage } = await import("./agents");
    const localized = await localizeMessage(
      followUp,
      ctx.region || undefined,
      ctx.sender,
      cfg.streetLocal
    );
    if (localized.text && localized.text !== followUp) {
      englishGloss = localized.english ?? followUp;
      followUp = localized.text;
    }
  }

  if (followUp && (await runSafety(followUp)).allowed) {
    // HUMAN THINKING TIME: a real person does not reply to a WhatsApp message
    // in under two seconds - instant replies are THE robotic tell. When the
    // sender has their own session (the queue can deliver for them), park the
    // reply with a jittered natural delay; the drain re-runs the anti-ban gate
    // at send time and uses the typing-presence path. Closers reply a bit
    // faster (a quick "thanks!" is natural), bargains "think" longer. A
    // strategist WAIT extends the hold - patience is a deliberate tactic.
    if (opts.humanDelay && ctx.sender) {
      // Snappy but human: an engaged shop is waiting, so replies land within a
      // strict ~1-2 min ceiling (owner). Still jittered - a sub-second reply is
      // the robotic tell. A strategist WAIT is deliberate but clamped to 90s so
      // it never blows the ceiling for an engaged shop.
      //
      // These bounds are pure SCHEDULING, not safety: every parked row is
      // re-gated at drain time (guardOutbound + the atomic claims), so tightening
      // them cannot outrun a floor - it only stops the delay stacking on top of
      // the LLM turn and the drain cadence into the minutes the field test saw.
      // The lower bound stays above the ~6s fleet gap; below that the claim
      // would just re-park the message and the cut would buy nothing.
      const delayS =
        strat.action === "wait" && strat.waitSeconds
          ? Math.min(strat.waitSeconds, 90)
          : followKind === "close" || followKind === "answer"
          ? 6 + Math.floor(Math.random() * 10) // 6-15s
          : 10 + Math.floor(Math.random() * 16); // 10-25s (a bargain "thinks")
      // Dedup: one pending row per shop (parkOutboxOnce replaces any older
      // pending row) so an awaiting-reply shop never accumulates duplicates.
      const { parkOutboxOnce } = await import("./wa/park");
      await parkOutboxOnce({
        senderKey: ctx.sender,
        toNumber: from,
        body: followUp,
        notBeforeMs: Date.now() + delayS * 1000,
        meta: {
          ...ctx,
          kind: `auto-${followKind}`,
          round: nextRound,
          auto: true,
          ...(englishGloss ? { englishGloss } : {}),
          // WHAT THIS DRAFT IS AN ANSWER TO. The drain re-reads it and refuses
          // to send a reply to a message the shop has already moved past - the
          // 12:39 bargain and the 12:43 close both went out after the shop had
          // said its piece, because nothing on the send path knew what they
          // were replying to. See wa/freshness.ts.
          composedAgainst: {
            inboundId: opts.waMessageId,
            inboundAt: new Date(turnStartedAt).toISOString(),
            quotePerDay: usablePrice,
            move: followKind,
          },
          reason:
            strat.action === "wait"
              ? "strategist hold - choosing the best reply order"
              : "human reply pacing (thinking time)",
        },
      });
      traces.push({
        ...traceBase,
        stage: "deliver",
        input: followUp,
        reasoning:
          strat.action === "wait"
            ? `strategist hold for ${delayS}s`
            : `parked with human thinking delay ${delayS}s`,
        output: `queued until +${delayS}s`,
      });
      stampTurnLatency(ctx.sender, from, {
        composeMs: Date.now() - turnStartedAt,
        plannedDelayS: delayS,
        outcome: "parked",
      });
      await writeTrace(traces);
      return;
    }

    // Anti-ban gate: engagement, business hours, reputation caps, variance.
    const verdict = await guardOutbound({
      senderKey: ctx.sender ?? "system",
      toDigits: from,
      text: followUp,
      auto: true,
      queueIfBlocked: true,
      meta: { ...ctx, kind: `auto-${followKind}`, round: nextRound, auto: true },
    });
    if (!verdict.allow) {
      traces.push({
        ...traceBase,
        stage: "deliver",
        input: followUp,
        reasoning: verdict.reason ?? "held by the anti-ban gate",
        output: "(queued/held)",
      });
      await writeTrace(traces);
      return;
    }
    // THE LAST SEND SITE WITHOUT AN ATOMIC CLAIM. guardOutbound's checks are
    // read-then-act, so N concurrent turns for the same sender all pass them
    // together - this branch could emit two replies milliseconds apart while
    // every drained row was properly serialized. It matters more now that the
    // engaged lane is fast: the window this races through is seconds wide.
    const senderKey = ctx.sender ?? "system";
    const claim = await claimForSend(senderKey, from, verdict.text, true, true);
    if (!claim.ok) {
      traces.push({
        ...traceBase,
        stage: "deliver",
        input: followUp,
        reasoning:
          claim.kind === "duplicate"
            ? "another turn is already delivering this exact message"
            : "pacing slot held by a concurrent send",
        output: "(held)",
      });
      await writeTrace(traces);
      return;
    }
    const result = await opts.send(from, verdict.text);
    // A failed send must free the message slot or its own retry reads as a
    // duplicate of itself. The gap slot is deliberately kept - the attempt
    // consumed the pacing window either way.
    if (!result.ok) await releaseSendClaim(senderKey, from, verdict.text);
    stampTurnLatency(ctx.sender, from, {
      composeMs: Date.now() - turnStartedAt,
      plannedDelayS: 0,
      outcome: result.ok ? "sent" : "send-failed",
    });
    if (result.ok) {
      await afterSend(ctx.sender ?? "system", from);
      await sbInsert("whatsapp_messages", [
        {
          // Provider id: lets the webhook's fromMe echo-check recognise OUR
          // send by id instead of guessing from the body (a wrong guess wrote a
          // fake "human takeover" row that orphaned the thread).
          wa_message_id: (result as { messageId?: string }).messageId ?? null,
          to_number: from,
          body: verdict.text,
          type: "text",
          direction: "outbound",
          raw: {
            ...ctx,
            kind: `auto-${followKind}`,
            round: nextRound,
            auto: true,
            ...(englishGloss ? { englishGloss } : {}),
          },
        },
      ]);
    }
    traces.push({
      ...traceBase,
      stage: "deliver",
      input: followUp,
      reasoning: result.ok ? "sent through the user's WhatsApp" : `send failed: ${result.error ?? "unknown"}`,
      output: verdict.text,
    });
  }
  await writeTrace(traces);
  }
}
