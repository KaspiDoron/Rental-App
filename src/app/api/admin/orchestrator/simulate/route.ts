import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { simulatePipeline, SIM_SCENARIOS, type SimInput } from "@/lib/simulate";

// Dry-run test bench (owner/manager only): push a hypothetical shop reply (or a
// preset scenario) through the REAL pipeline and get every stage's trace back -
// WITHOUT sending any WhatsApp message or writing an offer. Also runs a single
// owner-editable prompt against sample input so prompt quality can be verified.
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

  // Single-prompt tester: run one owner-editable prompt against sample input.
  if (body.action === "prompt") {
    const { getPrompt } = await import("@/lib/prompts");
    const { chat } = await import("@/lib/ai");
    const promptId = String(body.promptId ?? "");
    const sample = String(body.sampleInput ?? "").slice(0, 2000);
    if (!promptId) return NextResponse.json({ error: "Pick a prompt." }, { status: 400 });
    const system = await getPrompt(promptId);
    const out = await chat([
      { role: "system", content: system },
      { role: "user", content: sample || "(no sample input)" },
    ]);
    return NextResponse.json({ output: out ?? "(no AI key configured - add one in Keys to test prompts)" });
  }

  // Full-funnel simulation.
  let input: SimInput;
  if (body.scenarioId) {
    const preset = SIM_SCENARIOS.find((s) => s.id === body.scenarioId);
    if (!preset) return NextResponse.json({ error: "Unknown scenario." }, { status: 400 });
    input = preset.input;
  } else {
    input = {
      shopReply: String(body.shopReply ?? "").slice(0, 1000),
      region: body.region ? String(body.region).slice(0, 120) : undefined,
      imageKind: body.imageKind || undefined,
    };
    if (!input.shopReply && !input.imageKind) {
      return NextResponse.json({ error: "Type a shop reply or pick a scenario." }, { status: 400 });
    }
  }

  const result = await simulatePipeline(input);
  return NextResponse.json({ result, input });
}

// maxDuration: lift the request-timeout ceiling for slow AI upstreams.
export const maxDuration = 60;
