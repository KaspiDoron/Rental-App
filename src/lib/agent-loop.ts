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
const CLOSE_OK = [
  "Perfect, that works - thanks so much! I'll confirm with you shortly.",
  "Great, sounds good! Thanks a lot, I'll get back to you soon to confirm.",
];
const CLOSE_NO = [
  "No worries at all, thanks for letting me know! I'll think it over and get back to you.",
  "All good, I understand! Thanks for your time - I'll be in touch.",
];

/** Process one inbound vendor message; auto-extract + auto-respond (once). */
export async function processVendorReply(opts: {
  fromDigits: string;
  text: string;
  waMessageId?: string;
  images?: { mime: string; base64: string }[];
  send: SendFn;
}): Promise<void> {
  const text = opts.text.trim();
  const images = opts.images ?? [];
  // A price-list PHOTO with no caption is still a real reply we must read.
  if (!text && images.length === 0) return;
  const from = opts.fromDigits.replace(/[^\d]/g, "");

  // Dedupe: providers retry webhooks - never process the same message twice.
  if (opts.waMessageId) {
    const dup = await sbSelect(
      "whatsapp_messages",
      `select=id&wa_message_id=eq.${encodeURIComponent(opts.waMessageId)}&direction=eq.inbound&limit=2`
    );
    if (dup.length > 1) return;
  }

  // Find the thread: the last outbound message we sent this number.
  const prior = await sbSelect<OutboundRow>(
    "whatsapp_messages",
    `select=id,to_number,raw&direction=eq.outbound&to_number=eq.${encodeURIComponent(from)}&order=received_at.desc&limit=1`
  );
  const ctx = prior[0]?.raw;
  if (!ctx?.rfq) return; // reply without a known thread - stored, not processed

  const rfq = ctx.rfq as StructuredRFQ;
  const round = Number(ctx.round ?? 0);

  // A reply arrived: build the sender's trust score (anti-ban engagement).
  if (ctx.sender) await recordInboundEngagement(ctx.sender, from);

  // Read the WHOLE recent thread so the agent has real memory.
  const threadRows = await sbSelect<ThreadMsg>(
    "whatsapp_messages",
    `select=direction,body,raw,received_at&or=(to_number.eq.${encodeURIComponent(
      from
    )},from_number.eq.${encodeURIComponent(from)})&order=received_at.desc&limit=12`
  );
  const thread = threadRows.reverse();
  const history = thread
    .map((m) => `${m.direction === "outbound" ? "Us" : "Shop"}: ${(m.body ?? "").slice(0, 300)}`)
    .join("\n");
  const autoClarifies = thread.filter(
    (m) => m.direction === "outbound" && m.raw?.kind === "auto-clarify"
  ).length;
  const autoBargains = thread.filter(
    (m) => m.direction === "outbound" && m.raw?.kind === "auto-bargain"
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
  const usablePrice =
    extraction.found && extraction.pricePerDay
      ? extraction.pricePerDay
      : undefined;

  const cur =
    extraction.currency || currencyForRegion(ctx.region || undefined) || "USD";
  await sbInsert("vendor_replies", [
    {
      user_email: ctx.sender ?? null,
      vendor_id: ctx.vendorId ?? "",
      vendor_name: ctx.vendorName ?? "",
      reply_text: text.slice(0, 4000),
      image_count: images.length,
      found: extraction.found,
      price_per_day: extraction.pricePerDay ?? null,
      matches_spec: extraction.matchesSpec,
      confidence: extraction.confidence,
      auto: true,
      // The shop's own money + confirmed conditions, so the app can show the
      // real local price and honest tags (never a silent USD default).
      currency: cur,
      deposit: extraction.deposit ?? null,
      delivers: extraction.delivers ?? null,
    },
  ]);
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
    await sbInsert("offers", [
      {
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
        deposit_note: extraction.deposit ?? null,
      },
    ]);
  }

  // ---- Decide the ONE next move (or silence) --------------------------------
  let followUp: string | null = null;
  let followKind = "clarify";
  let nextRound = round;
  let englishGloss: string | undefined;

  if (!usablePrice && !verified && extraction.clarifyMessage && autoClarifies === 0) {
    // Genuinely no price yet and we have never clarified: ask once, politely.
    followUp = extraction.clarifyMessage;
  } else if (usablePrice && autoBargains === 0) {
    // First real quote: our single, floor-anchored ask.
    const floor = await floorPriceFor(ctx.region || undefined, rfq);
    const sameCur = floor && floor.currency === cur ? floor : null;
    const floorPrice = sameCur?.floor;
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
      const useLocal = Boolean(ctx.localLang) && ctx.plan === "ultra";
      const draft = await composeBargain({
        rfq,
        vendor: { name: ctx.vendorName ?? "the shop" } as Vendor,
        currentPricePerDay: usablePrice,
        rivalPricePerDay: rivalPrice,
        region: ctx.region || undefined,
        round: 1,
        currency: cur,
        localLanguage: useLocal,
        targetPricePerDay: target,
        floorPricePerDay: floorPrice,
        history,
      });
      followUp = draft.message;
      followKind = "bargain";
      nextRound = 1;
      // Ultra local-language: also keep a plain-English gloss so the user can
      // read what the agent is saying on their behalf.
      if (useLocal && draft.english) englishGloss = draft.english;
      await sbInsert("bargain_drafts", [
        {
          user_email: ctx.sender ?? null,
          vendor_id: ctx.vendorId ?? "",
          tactic: draft.tacticId,
          message: draft.message,
        },
      ]);
    }
  } else if (autoBargains >= 1 && autoCloses === 0) {
    // The shop answered our one ask. Whatever they said - accepted, countered
    // or refused - we thank them ONCE and stop. No pushing, ever.
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

  if (followUp && (await runSafety(followUp)).allowed) {
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
