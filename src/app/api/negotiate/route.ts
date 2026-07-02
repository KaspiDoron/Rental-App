import { NextResponse } from "next/server";
import { sentimentFor, verificationMessage, marketRateFor } from "@/lib/agents";
import type { Vendor, StructuredRFQ } from "@/lib/types";

interface Body {
  vendor: Vendor;
  rfq: StructuredRFQ;
  round: number;
  verify?: boolean;
}

// There are NO automatic prices anywhere. This endpoint only returns the
// Market-Rate Analyst's clearly-labelled estimate and the agent's spec
// verification text. Real prices enter the app exclusively through vendor
// replies (webhook or pasted reply -> extraction agent).
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.vendor || !body?.rfq) {
    return NextResponse.json({ error: "vendor and rfq required" }, { status: 400 });
  }

  if (body.verify) {
    return NextResponse.json({ verification: verificationMessage(body.rfq) });
  }

  return NextResponse.json({
    pending: true,
    estimateOnly: true,
    marketRate: marketRateFor(body.vendor, body.rfq),
    sentiment: sentimentFor(body.vendor, Math.max(0, body.round ?? 0)),
  });
}
