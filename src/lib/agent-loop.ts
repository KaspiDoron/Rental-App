// The agentic reply loop - shared by every inbound WhatsApp channel (official
// Meta Cloud API webhook AND per-user Evolution API sessions).
//
// For each vendor reply we: match the thread we opened (last outbound message
// to that number carries vendor + RFQ context), run the Offer Extraction
// Agent, store the offer so it pops into the app automatically, and let the
// agent answer by itself - a clarification question while the price is not
// confirmed for the exact vehicle, or the next bargaining move (local language
// for Ultra members) after the first confirmed quote. Replies go back out on
// the SAME channel the conversation lives on.

import "server-only";
import { sbInsert, sbSelect } from "./runtime-config";
import { extractOffer, composeBargain, runSafety } from "./agents";
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

export type SendFn = (
  to: string,
  message: string
) => Promise<{ ok: boolean; error?: string }>;

/** Process one inbound vendor message; auto-extract + auto-respond. */
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

  const extraction = await extractOffer(rfq, text);
  const verified =
    extraction.found && extraction.matchesSpec && extraction.confidence === "high";

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
  if (extraction.found && extraction.pricePerDay) {
    await sbInsert("offers", [
      {
        user_email: ctx.sender ?? null,
        vendor_id: ctx.vendorId ?? "",
        vendor_name: ctx.vendorName ?? "",
        price_per_day: extraction.pricePerDay,
        list_price_per_day: extraction.pricePerDay,
        currency: extraction.currency ?? "USD",
        round,
        simulated: false,
        verified,
      },
    ]);
  }

  // Agentic follow-up: clarify first, then one bargaining push after the
  // first confirmed quote. Every auto-message passes the safety screen.
  let followUp: string | null = null;
  let followKind = "clarify";
  let nextRound = round;
  if (!verified && extraction.clarifyMessage) {
    followUp = extraction.clarifyMessage;
  } else if (verified && round === 0 && extraction.pricePerDay) {
    const draft = await composeBargain({
      rfq,
      vendor: { name: ctx.vendorName ?? "the shop" } as Vendor,
      currentPricePerDay: extraction.pricePerDay,
      region: ctx.region || undefined,
      round: 1,
      localLanguage: ctx.plan === "ultra",
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

  if (followUp && (await runSafety(followUp)).allowed) {
    const result = await opts.send(from, followUp);
    if (result.ok) {
      await sbInsert("whatsapp_messages", [
        {
          to_number: from,
          body: followUp,
          type: "text",
          direction: "outbound",
          raw: { ...ctx, kind: `auto-${followKind}`, round: nextRound, auto: true },
        },
      ]);
    }
  }
}
