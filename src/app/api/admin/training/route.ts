import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { addTraining, listTraining } from "@/lib/memory";
import { sbInsert } from "@/lib/runtime-config";

// Teach the bargaining agents from real WhatsApp transcripts.
export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ examples: listTraining() });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { text, note } = await req.json().catch(() => ({}));
  if (!text || String(text).trim().length < 20) {
    return NextResponse.json(
      { error: "Paste a real conversation (at least a few lines)." },
      { status: 400 }
    );
  }
  const ex = addTraining(String(text), note ? String(note) : undefined);
  await sbInsert("agent_training", [
    { text: ex.text, note: ex.note ?? null, added_by: session.email },
  ]);
  return NextResponse.json({ ok: true, examples: listTraining() });
}
