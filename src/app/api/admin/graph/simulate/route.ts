import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { simulatePipeline, SIM_SCENARIOS, type SimInput } from "@/lib/simulate";

// Dry-run the REAL digraph engine against a hypothetical shop reply / preset
// scenario, returning the exact traversed node path + every stage's trace -
// WITHOUT sending any WhatsApp message or writing an offer.
export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({
    scenarios: SIM_SCENARIOS.map((s) => ({ id: s.id, label: s.label, input: s.input })),
  });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));

  let input: SimInput;
  if (body.scenarioId) {
    const preset = SIM_SCENARIOS.find((s) => s.id === body.scenarioId);
    if (!preset) return NextResponse.json({ error: "Unknown scenario." }, { status: 400 });
    input = preset.input;
  } else {
    input = {
      shopReply: String(body.shopReply ?? "").slice(0, 1000),
      transcript: body.transcript ? String(body.transcript).slice(0, 1000) : undefined,
      region: body.region ? String(body.region).slice(0, 120) : undefined,
      imageKind: body.imageKind || undefined,
      rivalPricePerDay:
        Number(body.rivalPricePerDay) > 0 ? Number(body.rivalPricePerDay) : undefined,
      stateOverrides:
        body.stateOverrides && typeof body.stateOverrides === "object"
          ? body.stateOverrides
          : undefined,
      rfq: body.rfq && typeof body.rfq === "object" ? body.rfq : undefined,
    };
    if (!input.shopReply && !input.imageKind && !input.transcript) {
      return NextResponse.json(
        { error: "Type a shop reply, a transcript, or pick a scenario." },
        { status: 400 }
      );
    }
  }

  const result = await simulatePipeline(input);
  return NextResponse.json({ result, input });
}

export const maxDuration = 60;
