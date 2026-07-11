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
import { sbInsert, sbSelect } from "./runtime-config";
import { extractOffer, composeBargain, runSafety, currencyForRegion } from "./agents";
import { floorPriceFor } from "./market";
import { guardOutbound, afterSend, recordInboundEngagement } from "./wa-guard";
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
  const text = opts.text.trim();
  const images = opts.images ?? [];
  // A price-list PHOTO with no caption is still a real reply we must read.
  if (!text && images.length === 0) return;
  const from = opts.fromDigits.replace(/[^\d]/g, "");
  const senderFilter = opts.senderEmail
    ? `&raw->>sender=eq.${encodeURIComponent(opts.senderEmail)}`
    : "";

  // Dedupe: providers retry webhooks - never process the same message twice.
  if (opts.waMessageId) {
    const dup = await sbSelect(
      "whatsapp_messages",
      `select=id&wa_message_id=eq.${encodeURIComponent(opts.waMessageId)}&direction=eq.inbound&limit=2`
    );
    if (dup.length > 1) return;
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
  const mine = opts.senderEmail
    ? threadRows.filter(
        (m) =>
          m.direction === "inbound" ||
          (m.raw as { sender?: string } | null)?.sender === opts.senderEmail
      )
    : threadRows;
  const thread = mine.slice(0, 12).reverse();
  const history = thread
    .map((m) => `${m.direction === "outbound" ? "Us" : "Shop"}: ${(m.body ?? "").slice(0, 300)}`)
    .join("\n");
  const autoClarifies = thread.filter(
    (m) => m.direction === "outbound" && m.raw?.kind === "auto-clarify"
  ).length;
  // COUNT EVERY BARGAIN, including the ones the USER tapped from the app
  // (kind "bargain"). Counting only auto-bargains made the loop push a SECOND
  // ask after a user-initiated one - the "asked twice after the shop said no"
  // bug. One ask per shop means one ask, whoever triggered it.
  const autoBargains = thread.filter(
    (m) =>
      m.direction === "outbound" &&
      (m.raw?.kind === "auto-bargain" || m.raw?.kind === "bargain")
  ).length;
  const autoAnswers = thread.filter(
    (m) => m.direction === "outbound" && m.raw?.kind === "auto-answer"
  ).length;
  const autoCloses = thread.filter(
    (m) => m.direction === "outbound" && m.raw?.kind === "auto-close"
  ).length;

  // Funnel-gap detector: shops that dodge with "come to the shop and we'll
  // talk" / "depends" answers need a NEW branch in the negotiation funnel.
  // Log an owner notification so the funnel keeps learning from real gaps.
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
    // Auto-grow a branch on the funnel tree for this vague case (New#10).
    import("./funnel")
      .then((m) => m.autoBranchVague(text.slice(0, 120)))
      .catch(() => {});
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
    { ...replyBase, currency: cur, deposit: extraction.deposit ?? null, delivers: extraction.delivers ?? null },
  ]);
  if (!fullOk) await sbInsert("vendor_replies", [replyBase]);
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
    // Retry without the newest column if the migration has not run yet.
    const offerOk = await sbInsert("offers", [
      { ...offerBase, deposit_note: extraction.deposit ?? null },
    ]);
    if (!offerOk) await sbInsert("offers", [offerBase]);
  }

  // ---- Decide the ONE next move (or silence) --------------------------------
  let followUp: string | null = null;
  let followKind = "clarify";
  let nextRound = round;
  let englishGloss: string | undefined;

  const useLocalLang = Boolean(ctx.localLang) && ctx.plan === "ultra";

  if (sessionClosed) {
    // The user ended this search session: the reply is stored above, the deal
    // data is safe, and the agent stays SILENT. No clarify, no bargain, no
    // closer - a dead session never talks.
    followUp = null;
  } else if (shopAskedQuestion(text) && autoAnswers < 2) {
    // The shop asked US something ("you mean motorbike or car?"). ANSWER it -
    // never thank-and-close over an open question. Restate only what the RFQ
    // actually says; the deterministic fallback covers an AI outage.
    const { chat } = await import("./ai");
    const spec = fallbackAnswer(rfq);
    const llm = await chat([
      {
        role: "system",
        content:
          "You are the traveller in a WhatsApp chat with a vehicle rental shop. " +
          "The shop just asked a question. Answer ONLY that question in ONE short, " +
          "casual, friendly sentence (max 25 words), strictly using these facts - " +
          `never invent anything: ${spec} ` +
          "Do not re-ask for the price if the shop already gave one for our exact vehicle. " +
          "HARD RULE: NEVER accept a deal, never confirm a booking, never say a price " +
          "'works' - only the traveller decides that. If the shop is asking whether we " +
          "take their offer, say you will think it over and get back to them. " +
          "Reply with the message text only.",
      },
      { role: "user", content: `Conversation so far:\n${history}\n\nShop's question: ${text}` },
    ]);
    followUp = (llm ?? "").trim().slice(0, 300) || spec;
    followKind = "answer";
  } else if (!usablePrice && !verified && extraction.clarifyMessage && autoClarifies === 0) {
    // Genuinely no price yet and we have never clarified: ask once, politely.
    followUp = extraction.clarifyMessage;
  } else if (usablePrice && extraction.matchesSpec !== false && autoBargains === 0) {
    // First real quote for OUR vehicle: our single, floor-anchored ask. A price
    // for a DIFFERENT vehicle (matchesSpec false) is never bargained on.
    const floorPrice = floorSameCur?.floor;
    // If they already quoted at/below the local floor, there is nothing to
    // bargain - close warmly instead of insulting a great price.
    if (floorPrice && usablePrice <= floorPrice * 1.05) {
      if (autoCloses === 0) {
        followUp = `${CLOSE_OK[Math.floor(Math.random() * CLOSE_OK.length)]}`;
        followKind = "close";
      }
    } else {
      // CROSS-SHOP LEVERAGE (same search session): if ANOTHER shop already
      // quoted this traveller a lower price for the SAME vehicle, use it as real
      // negotiating leverage - "I have an offer at 180, can you beat it?". This
      // is the smart, competitive move a human would make.
      let rivalPrice: number | undefined;
      if (ctx.sender) {
        const { vehicleKeyFor } = await import("./market");
        const vkey = vehicleKeyFor(rfq);
        const since = new Date(Date.now() - 18 * 3600_000).toISOString();
        const rivals = await sbSelect<{ price_per_day: number }>(
          "offers",
          `select=price_per_day&user_email=eq.${encodeURIComponent(
            ctx.sender
          )}&simulated=eq.false&currency=eq.${encodeURIComponent(
            cur
          )}&vehicle_key=eq.${encodeURIComponent(vkey)}&vendor_id=neq.${encodeURIComponent(
            ctx.vendorId ?? ""
          )}&price_per_day=lt.${usablePrice}&created_at=gte.${encodeURIComponent(
            since
          )}&order=price_per_day.asc&limit=1`
        );
        rivalPrice = rivals[0]?.price_per_day;
      }

      const baseTarget = floorPrice
        ? Math.max(floorPrice, Math.round(usablePrice * 0.6))
        : Math.round(usablePrice * 0.85);
      // With a real rival price, aim the ask at (or just under) it - but never
      // below the local floor. Without one, use the standard target.
      const target = rivalPrice
        ? Math.max(floorPrice ?? 0, Math.min(baseTarget, rivalPrice))
        : baseTarget;
      // ARITHMETIC SANITY: a bargain ask must be BELOW what the shop asks.
      // If the computed target is not a real saving (>= ~95% of the quote),
      // asking would be nonsense ("they said 300, we ask 540") - close warmly
      // instead.
      if (target >= usablePrice * 0.95) {
        if (autoCloses === 0) {
          followUp = CLOSE_OK[Math.floor(Math.random() * CLOSE_OK.length)];
          followKind = "close";
        }
      } else {
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
      });
      followUp = draft.message;
      followKind = "bargain";
      nextRound = 1;
      // Ultra local-language: also keep a plain-English gloss so the user can
      // read what the agent is saying on their behalf.
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
    }
  } else if (autoBargains >= 1 && autoCloses === 0) {
    // The shop answered our one ask. Whatever they said - accepted, countered
    // or refused - we thank them ONCE and stop. No pushing, ever. The closer
    // NEVER implies the deal is taken - only the traveller confirms a booking.
    const saidYes =
      usablePrice !== undefined ||
      /\b(ok|okay|yes|sure|deal|can do|no problem)\b/i.test(text);
    followUp = saidYes
      ? CLOSE_OK[Math.floor(Math.random() * CLOSE_OK.length)]
      : CLOSE_NO[Math.floor(Math.random() * CLOSE_NO.length)];
    followKind = "close";
    nextRound = round + 1;
  }
  // Anything else: stay silent. Silence is the most human move there is.

  // LANGUAGE STICKINESS: a thread that started in the shop's local language
  // NEVER flips to English mid-conversation (the "agent suddenly switched to
  // English" bug). Bargains come localized from composeBargain already; the
  // clarify / answer / close paths are localized here, keeping the faithful
  // English gloss for the traveller.
  if (followUp && useLocalLang && followKind !== "bargain") {
    const { localizeMessage } = await import("./agents");
    const localized = await localizeMessage(
      followUp,
      ctx.region || undefined,
      ctx.sender
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
    // faster (a quick "thanks!" is natural), bargains "think" longer.
    if (opts.humanDelay && ctx.sender) {
      const delayS =
        followKind === "close" || followKind === "answer"
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
            reason: "human reply pacing (thinking time)",
          },
        },
      ]);
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
    if (!verdict.allow) return; // queued for later or held by the guard
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
  }
}
