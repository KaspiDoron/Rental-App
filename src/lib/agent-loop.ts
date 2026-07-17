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
import { extractOffer, composeBargain, runSafety, currencyForRegion } from "./agents";
import { floorPriceFor } from "./market";
import { guardOutbound, afterSend, recordInboundEngagement } from "./wa-guard";
import type { TraceRow } from "./orchestrator";
import type { StructuredRFQ, Vendor } from "./types";

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
  // Queue the agent's reply with a natural "thinking" delay instead of
  // answering within seconds (instant replies are the biggest bot tell).
  // Only for senders whose own session can deliver from the queue.
  humanDelay?: boolean;
  send: SendFn;
}): Promise<void> {
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
  const from = opts.fromDigits.replace(/[^\d]/g, "");
  const senderFilter = opts.senderEmail
    ? `&raw->>sender=eq.${encodeURIComponent(opts.senderEmail)}`
    : "";

  // Dedupe via an ATOMIC CLAIM. Providers retry webhooks and two deliveries of
  // the same message can arrive concurrently; a count-based check let BOTH
  // proceed (double reply) or BOTH bail (no reply). Claim the message id by
  // inserting into wa_processed (primary key = wa_message_id): exactly one
  // insert wins. Falls back to the legacy count check when the table is not
  // migrated yet, so un-migrated deployments never silently go silent.
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
    }
  }

  // Find the thread: the last outbound THIS USER sent this number.
  const prior = await sbSelect<OutboundRow & { received_at: string }>(
    "whatsapp_messages",
    `select=id,to_number,raw,received_at&direction=eq.outbound&to_number=eq.${encodeURIComponent(
      from
    )}${senderFilter}&order=received_at.desc&limit=1`
  );
  const ctx = prior[0]?.raw;
  if (!ctx?.rfq) return; // reply without a known thread - stored, not processed

  // SESSION LIFECYCLE GUARD: if the user closed the search session AFTER our
  // last outbound in this thread, the thread is DEAD. We still store the reply
  // below (data is never lost) but the agent says nothing more - a closed
  // session must never keep talking to shops. A new search re-opens the shop
  // with a fresh outbound, which then postdates the marker.
  let sessionClosed = false;
  if (ctx.sender && prior[0]?.received_at) {
    const marker = await sbSelect<{ received_at: string }>(
      "whatsapp_messages",
      `select=received_at&to_number=eq.session&raw->>sender=eq.${encodeURIComponent(
        ctx.sender
      )}&raw->>kind=eq.session-closed&order=received_at.desc&limit=1`
    );
    sessionClosed = Boolean(
      marker[0] && marker[0].received_at > prior[0].received_at
    );
  }

  const rfq = ctx.rfq as StructuredRFQ;
  const round = Number(ctx.round ?? 0);

  // A reply arrived: build the sender's trust score (anti-ban engagement).
  if (ctx.sender) await recordInboundEngagement(ctx.sender, from);

  // Read the WHOLE recent thread so the agent has real memory. Outbound rows
  // from OTHER users to the same shop are dropped - each user has their own
  // private thread with a shop (ask-once counters must never cross users).
  const threadRows = await sbSelect<ThreadMsg>(
    "whatsapp_messages",
    `select=direction,body,raw,received_at&or=(to_number.eq.${encodeURIComponent(
      from
    )},from_number.eq.${encodeURIComponent(from)})&order=received_at.desc&limit=20`
  );
  // PRIVACY: BOTH directions are scoped to this user - outbound by sender,
  // inbound by receiver (the user whose WhatsApp actually got the message).
  // Another user's chat with the same number must never enter this context.
  const mine = opts.senderEmail
    ? threadRows.filter((m) => {
        const raw = m.raw as { sender?: string; receiver?: string } | null;
        return m.direction === "inbound"
          ? raw?.receiver === opts.senderEmail
          : raw?.sender === opts.senderEmail;
      })
    : threadRows;
  const thread = mine.slice(0, 12).reverse();
  const history = thread
    .map((m) => `${m.direction === "outbound" ? "Us" : "Shop"}: ${(m.body ?? "").slice(0, 300)}`)
    .join("\n");
  // PENDING REPLIES COUNT TOO. A reply parked in wa_outbox with a human
  // "thinking" delay is NOT yet in whatsapp_messages. Without counting it, a
  // SECOND shop message arriving inside that 45-240s window reads the counters
  // as zero and queues ANOTHER bargain/clarify - the exact double-ask this
  // discipline exists to prevent. Include the pending outbox for this thread.
  const pendingOutbox = ctx.sender
    ? await sbSelect<{ meta: { kind?: string } | null }>(
        "wa_outbox",
        `select=meta&sender_key=eq.${encodeURIComponent(
          ctx.sender
        )}&to_number=eq.${encodeURIComponent(from)}&limit=20`
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
        (m.raw?.kind === "auto-bargain" || m.raw?.kind === "bargain")
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

  const extraction = await extractOffer(
    rfq,
    text || "(the shop sent a price-list photo)",
    images,
    history,
    ctx.region || undefined
  );
  const verified =
    extraction.found && extraction.matchesSpec && extraction.confidence === "high";
  // After we've clarified once, a found price counts even if not fully
  // verified - the human can see it; the agent must not nag the shop again.
  let usablePrice =
    extraction.found && extraction.pricePerDay
      ? extraction.pricePerDay
      : undefined;

  const cur =
    extraction.currency || currencyForRegion(ctx.region || undefined) || "USD";

  // TOTAL vs PER-DAY sanity net. Shops constantly quote the WHOLE rental
  // ("3 day 900 B" = 900 TOTAL = 300/day) and a mis-read here made the agent
  // "bargain" for MORE than the shop's real daily price - the worst possible
  // move. If the number is wildly above the area's typical daily price but
  // divides into a plausible daily price over the rental length, it was a
  // total: divide it. (The extraction prompt now rules this too; this is the
  // arithmetic backstop for when the model slips.)
  const floor = await floorPriceFor(ctx.region || undefined, rfq);
  const floorSameCur = floor && floor.currency === cur ? floor : null;
  if (usablePrice && rfq.durationDays > 1 && floorSameCur) {
    const typical = floorSameCur.typical ?? Math.round(floorSameCur.floor * 1.6);
    const perDayIfTotal = Math.round(usablePrice / rfq.durationDays);
    if (usablePrice >= typical * 2 && perDayIfTotal >= floorSameCur.floor * 0.55) {
      usablePrice = perDayIfTotal;
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
  if (usablePrice) {
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
      list_price_per_day: usablePrice,
      currency: cur,
      round,
      simulated: false,
      verified,
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
  }

  // Web Push: alert the traveller a shop replied even if the app is CLOSED, so
  // they can leave the app and come back. Fire-and-forget; no-op without VAPID.
  if (ctx.sender) {
    const shop = ctx.vendorName || "A rental shop";
    const body = usablePrice
      ? `${shop} offered ${usablePrice} ${cur}/day - tap to see the deal.`
      : `${shop} just replied - tap to open WheelDeal.`;
    import("./push")
      .then((m) => m.sendPushToUser(ctx.sender!, { title: "New reply 🛵", body, url: "/" }))
      .catch(() => {});
  }

  // INBOUND GLOSS (fire-and-forget): translate a local-language shop reply to
  // English and stamp it on the stored inbound row (raw.english), so every
  // surface (card peek, transcript) shows the translation under the original.
  // The traveller must always understand the conversation their agent is
  // having - that IS the product.
  if (ctx.sender && text) {
    void (async () => {
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
            : `select=id,raw&direction=eq.inbound&from_number=eq.${encodeURIComponent(
                from
              )}${receiverScope}&order=received_at.desc&limit=1`
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
    })();
  }

  // INBOUND SAFETY SCREEN (fire-and-forget): flag risky shop asks - passport
  // photos, off-platform transfers, shady links - for the USER. Never touches
  // what the engine replies.
  //
  // NEVER SELF-FLAG: a message the user wrote themselves (a lost fromMe flag
  // upstream can mislabel it inbound) must not be screened as "the shop's
  // reply" - anything matching our recent outbound to this number is skipped.
  if (ctx.sender && text) {
    void (async () => {
      try {
        const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
        const ours = await sbSelect<{ body: string }>(
          "whatsapp_messages",
          `select=body&direction=eq.outbound&to_number=eq.${encodeURIComponent(
            from
          )}&raw->>sender=eq.${encodeURIComponent(
            ctx.sender!
          )}&received_at=gte.${encodeURIComponent(
            new Date(Date.now() - 24 * 3600_000).toISOString()
          )}&order=received_at.desc&limit=30`
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
        const { sendPushToUser } = await import("./push");
        await sendPushToUser(ctx.sender!, {
          title: verdict.risk === "high" ? "⚠️ Check this reply" : "Heads up on a reply",
          body: `${ctx.vendorName || "A shop"}: ${verdict.reasons[0] ?? "review this message before acting"}`,
          url: "/",
        });
      } catch {
        /* screening is best-effort */
      }
    })();
  }

  // HUMAN TAKEOVER GATE (pre-engine): the user typed in this shop's thread
  // themselves - the agents stand down for THIS thread until handback. The
  // reply was stored and pushed above; we just don't answer it.
  if (ctx.sender && !sessionClosed) {
    try {
      const { isThreadTakenOver } = await import("./session-flags");
      if (await isThreadTakenOver(ctx.sender, from)) return;
    } catch {
      /* flags unreadable - fail open */
    }
  }

  // SESSION PAUSE GATE (pre-engine, same philosophy as sessionClosed): the
  // user told Will to hold everything. The reply was stored and the push sent
  // above - the agents just say NOTHING until the user resumes.
  if (ctx.sender && !sessionClosed) {
    try {
      const { isSessionPaused } = await import("./session-flags");
      if (await isSessionPaused(ctx.sender)) return;
    } catch {
      /* flags unreadable - fail open, the engine's own guards still apply */
    }
  }

  // ==== THE DIGRAPH NEGOTIATION ENGINE (v2) ==================================
  // The default path: a true directed graph of specialized agents driven by a
  // chief Negotiation Director (multi-round bargaining, deposit + fulfillment
  // probing, strategic waits, media coherence, judge scoring). The legacy
  // inline pipeline below is kept behind GRAPH_ENGINE=off for one release.
  const { graphEngineEnabled } = await import("./graph/engine");
  if (await graphEngineEnabled()) {
    const { runGraphTurn, liveGraphIO } = await import("./graph/engine");
    const { threadKeyFor } = await import("./graph/state");
    const eventKind: "inbound-text" | "inbound-image" =
      images.length > 0 ? "inbound-image" : "inbound-text";
    await runGraphTurn(
      {
        event: {
          kind: eventKind,
          threadKey: threadKeyFor(ctx.sender ?? undefined, from),
          userEmail: ctx.sender ?? undefined,
          toDigits: from,
          shopMessage: text,
          images,
          audios: [],
        },
        ctx,
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
        legacyCounts: {
          clarify: autoClarifies,
          bargain: autoBargains,
          answer: autoAnswers,
          close: autoCloses,
        },
        humanDelay: Boolean(opts.humanDelay && ctx.sender),
        transcript: opts.transcript ?? null,
        deadlineAt: Date.now() + 45_000,
      },
      liveGraphIO(opts.send)
    );
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
    verified,
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
      round: 1,
      currency: cur,
      localLanguage: useLocalLang,
      targetPricePerDay: target,
      floorPricePerDay: floorPrice,
      history,
      voiceKey: ctx.sender ?? undefined,
      extraDirectives: [register, ownerDirectives(cfg, "price"), strat.leverageNote ? `Real leverage you may mention: ${strat.leverageNote}.` : ""]
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
      const delayS =
        strat.action === "wait" && strat.waitSeconds
          ? strat.waitSeconds
          : followKind === "close" || followKind === "answer"
          ? 20 + Math.floor(Math.random() * 70) // 20-90s
          : 45 + Math.floor(Math.random() * 195); // 45-240s
      await sbInsert("wa_outbox", [
        {
          sender_key: ctx.sender,
          to_number: from,
          body: followUp,
          not_before: new Date(Date.now() + delayS * 1000).toISOString(),
          meta: {
            ...ctx,
            kind: `auto-${followKind}`,
            round: nextRound,
            auto: true,
            ...(englishGloss ? { englishGloss } : {}),
            reason:
              strat.action === "wait"
                ? "strategist hold - choosing the best reply order"
                : "human reply pacing (thinking time)",
          },
        },
      ]);
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
    const result = await opts.send(from, verdict.text);
    if (result.ok) {
      await afterSend(ctx.sender ?? "system", from);
      await sbInsert("whatsapp_messages", [
        {
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
