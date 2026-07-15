import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import {
  simulatePipeline,
  simulateConversation,
  playgroundTurn,
  SIM_SCENARIOS,
  CONVERSATION_SCRIPTS,
  type SimInput,
} from "@/lib/simulate";

// Dry-run the REAL digraph engine against a hypothetical shop reply / preset
// scenario, returning the exact traversed node path + every stage's trace -
// WITHOUT sending any WhatsApp message or writing an offer.
export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({
    scenarios: SIM_SCENARIOS.map((s) => ({ id: s.id, label: s.label, input: s.input })),
    conversations: CONVERSATION_SCRIPTS.map((c) => ({ id: c.id, label: c.label })),
  });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));

  // Full multi-turn negotiation playback (the Scenario Player): plays one of
  // the owner's example shop scripts against the REAL engine, carrying state
  // across turns, and returns every turn's path + reply + deal state.
  if (body.action === "conversation") {
    const script = CONVERSATION_SCRIPTS.find((c) => c.id === body.scriptId);
    if (!script) return NextResponse.json({ error: "Unknown conversation script." }, { status: 400 });
    const result = await simulateConversation({
      turns: script.turns,
      rfq: script.rfq,
      region: script.region,
    });
    return NextResponse.json({ conversation: result, script: { id: script.id, label: script.label } });
  }

  // Interactive Playground: the owner acts as the rental shop (or lets an AI
  // persona play the shop). Thread state + history round-trip through the
  // client so consecutive calls continue the same negotiation - dry-run IO,
  // zero WhatsApp traffic.
  if (body.action === "playground") {
    const result = await playgroundTurn({
      shopSays: body.shopSays ? String(body.shopSays).slice(0, 1000) : undefined,
      voice: Boolean(body.voice),
      imageKind:
        body.imageKind === "vehicle" || body.imageKind === "price_sheet" ? body.imageKind : undefined,
      rivalPricePerDay:
        Number(body.rivalPricePerDay) > 0 ? Number(body.rivalPricePerDay) : undefined,
      rfq: body.rfq && typeof body.rfq === "object" ? body.rfq : undefined,
      region: body.region ? String(body.region).slice(0, 120) : undefined,
      carried: body.carried,
      historyLines: Array.isArray(body.historyLines) ? body.historyLines : undefined,
      aiShop: Boolean(body.aiShop),
      persona: body.persona ? String(body.persona).slice(0, 1200) : undefined,
    });
    return NextResponse.json({ playground: result });
  }

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
