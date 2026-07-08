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
  send: SendFn;
}): Promise<void> {
  const text = opts.text.trim();
  if (!text) return;
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
  }

  const extraction = await extractOffer(rfq, text, [], history);
  const verified =
    extraction.found && extraction.matchesSpec && extraction.confidence === "high";
  // After we've clarified once, a found price counts even if not fully
  // verified - the human can see it; the agent must not nag the shop again.
  const usablePrice =
    extraction.found && extraction.pricePerDay
      ? extraction.pricePerDay
      : undefined;

  await sbInsert("vendor_replies", [
    {
      user_email: ctx.sender ?? null,
      vendor_id: ctx.vendorId ?? "",
      vendor_name: ctx.vendorName ?? "",
      reply_text: text.slice(0, 4000),
      image_count: 0,
      found: extraction.found,
      price_per_day: extraction.pricePerDay ?? null,
      matches_spec: extraction.matchesSpec,
      confidence: extraction.confidence,
      auto: true,
    },
  ]);
  const cur =
    extraction.currency || currencyForRegion(ctx.region || undefined) || "USD";
  if (usablePrice) {
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
      },
    ]);
  }

  // ---- Decide the ONE next move (or silence) --------------------------------
  let followUp: string | null = null;
  let followKind = "clarify";
  let nextRound = round;

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
      const target = floorPrice
        ? Math.max(floorPrice, Math.round(usablePrice * 0.6))
        : Math.round(usablePrice * 0.85);
      const draft = await composeBargain({
        rfq,
        vendor: { name: ctx.vendorName ?? "the shop" } as Vendor,
        currentPricePerDay: usablePrice,
        region: ctx.region || undefined,
        round: 1,
        currency: cur,
        localLanguage: ctx.plan === "ultra",
        targetPricePerDay: target,
        floorPricePerDay: floorPrice,
        history,
      });
      followUp = draft.message;
      followKind = "bargain";
      nextRound = 1;
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
          raw: { ...ctx, kind: `auto-${followKind}`, round: nextRound, auto: true },
        },
      ]);
    }
  }
}
