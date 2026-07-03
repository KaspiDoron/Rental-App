import { NextResponse } from "next/server";
import { composeBargain, runSafety } from "@/lib/agents";
import { getSession } from "@/lib/session";
import { sbInsert } from "@/lib/runtime-config";
import type { Vendor, StructuredRFQ } from "@/lib/types";

// Adaptive Bargaining Agent: composes the next negotiation message to send.
// Learned tactics + owner training transcripts + region-matched English level.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body?.vendor || !body?.rfq) {
    return NextResponse.json({ error: "vendor and rfq required" }, { status: 400 });
  }

  // Local-language street bargaining is an Ultra perk (management included).
  const wantsLocal = body.language === "local";
  const isUltra = session.plan === "ultra";
  if (wantsLocal && !isUltra) {
    return NextResponse.json(
      {
        error: "Bargaining in the shop's local language is an Ultra feature.",
        upgrade: true,
      },
      { status: 403 }
    );
  }

  const draft = await composeBargain({
    rfq: body.rfq as StructuredRFQ,
    vendor: body.vendor as Vendor,
    currentPricePerDay: body.currentPricePerDay,
    rivalPricePerDay: body.rivalPricePerDay,
    region: body.region,
    round: Math.max(0, Number(body.round ?? 0)),
    localLanguage: wantsLocal && isUltra,
  });

  // Safety-screen even our own composed drafts before they can be sent.
  const verdict = await runSafety(draft.message);
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: "Draft failed the safety screen - try again." },
      { status: 500 }
    );
  }

  await sbInsert("bargain_drafts", [
    {
      user_email: session.email,
      vendor_id: String(body.vendor.id ?? ""),
      tactic: draft.tacticId,
      message: draft.message,
    },
  ]);

  return NextResponse.json(draft);
}
