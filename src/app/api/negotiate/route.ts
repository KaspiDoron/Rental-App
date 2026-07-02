import { NextResponse } from "next/server";
import {
  negotiateRound,
  sentimentFor,
  verificationMessage,
  marketRateFor,
} from "@/lib/agents";
import { recordRun } from "@/lib/memory";
import { getSession } from "@/lib/session";
import { sbInsert } from "@/lib/runtime-config";
import type { Vendor, StructuredRFQ } from "@/lib/types";

interface Body {
  vendor: Vendor;
  rfq: StructuredRFQ;
  round: number;
  cycleSeconds?: number;
  verify?: boolean;
}

// Negotiation endpoint.
// - Demo vendors: round-based simulation (offers labelled `simulated`).
// - Real vendors (Google Places): we NEVER invent a price. The response is
//   `pending` with an estimated market rate clearly marked as an estimate;
//   real offers arrive only from actual vendor replies (WhatsApp webhook) and
//   are `verified` only after the agent confirms the exact vehicle + price.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.vendor || !body?.rfq) {
    return NextResponse.json({ error: "vendor and rfq required" }, { status: 400 });
  }

  if (body.verify) {
    return NextResponse.json({ verification: verificationMessage(body.rfq) });
  }

  const round = Math.max(0, Math.min(4, body.round ?? 0));
  const estimate = marketRateFor(body.vendor, body.rfq);

  if (!body.vendor.demo) {
    return NextResponse.json({
      pending: true,
      estimateOnly: true,
      marketRate: estimate,
      sentiment: sentimentFor(body.vendor, round),
    });
  }

  const { offer } = negotiateRound(body.vendor, body.rfq, round);
  const sentiment = sentimentFor(body.vendor, round);
  if (round === 0) recordRun(1, body.cycleSeconds ?? 6);

  // Save every offer to agent memory (no-op without Supabase).
  const session = await getSession();
  await sbInsert("offers", [
    {
      user_email: session?.email ?? null,
      vendor_id: body.vendor.id,
      vendor_name: body.vendor.name,
      price_per_day: offer.pricePerDay,
      list_price_per_day: offer.listPricePerDay,
      currency: offer.currency,
      round,
      simulated: true,
      verified: false,
    },
  ]);

  return NextResponse.json({ offer, sentiment, marketRate: estimate });
}
