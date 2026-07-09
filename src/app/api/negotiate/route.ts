import { NextResponse } from "next/server";
import { sentimentFor, verificationMessage } from "@/lib/agents";
import type { Vendor, StructuredRFQ } from "@/lib/types";

interface Body {
  vendor: Vendor;
  rfq: StructuredRFQ;
  round: number;
  verify?: boolean;
}

// There are NO automatic prices anywhere - not even labelled "estimates".
// We first need to ask the shops. This endpoint only returns the Sentiment
// agent's read and the spec-verification text; real prices enter the app
// exclusively through vendor replies (webhook or pasted reply -> extraction).
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
    sentiment: sentimentFor(body.vendor, Math.max(0, body.round ?? 0)),
  });
}

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
