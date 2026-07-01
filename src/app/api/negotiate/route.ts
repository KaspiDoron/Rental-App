import { NextResponse } from "next/server";
import {
  negotiateRound,
  sentimentFor,
  verificationMessage,
  marketRateFor,
} from "@/lib/agents";
import { recordRun } from "@/lib/memory";
import type { Vendor, StructuredRFQ } from "@/lib/types";

interface Body {
  vendor: Vendor;
  rfq: StructuredRFQ;
  round: number;
  cycleSeconds?: number;
  verify?: boolean;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.vendor || !body?.rfq) {
    return NextResponse.json({ error: "vendor and rfq required" }, { status: 400 });
  }

  if (body.verify) {
    return NextResponse.json({ verification: verificationMessage(body.rfq) });
  }

  const round = Math.max(0, Math.min(4, body.round ?? 0));
  const { offer } = negotiateRound(body.vendor, body.rfq, round);
  const sentiment = sentimentFor(body.vendor, round);

  if (round === 0) recordRun(1, body.cycleSeconds ?? 6);

  return NextResponse.json({
    offer,
    sentiment,
    marketRate: marketRateFor(body.vendor, body.rfq),
  });
}
