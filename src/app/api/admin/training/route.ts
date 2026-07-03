import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { addTraining, listTraining } from "@/lib/memory";
import { sbInsert, sbSelect } from "@/lib/runtime-config";
import { chatVision } from "@/lib/ai";

// Teach the bargaining agents from real WhatsApp bargains - pasted text AND
// chat screenshots (the vision agent transcribes photos into dialogue).

interface TrainingRow {
  id: number;
  text: string;
  note: string | null;
  source: string | null;
  created_at: string;
}

async function allExamples() {
  const durable = await sbSelect<TrainingRow>(
    "agent_training",
    "select=id,text,note,source,created_at&order=created_at.desc&limit=50"
  );
  const mem = listTraining();
  const seen = new Set(durable.map((d) => d.text));
  return [
    ...durable.map((d) => ({
      id: d.id,
      text: d.text,
      note: d.note ?? undefined,
      addedAt: Date.parse(d.created_at),
    })),
    ...mem.filter((m) => !seen.has(m.text)),
  ];
}

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ examples: await allExamples() });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const text = String(body.text ?? "").trim();

  const images: { mime: string; base64: string }[] = [];
  for (const dataUrl of (body.images ?? []).slice(0, 5)) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(String(dataUrl));
    if (m) images.push({ mime: m[1], base64: m[2] });
  }

  if (text.length < 20 && images.length === 0) {
    return NextResponse.json(
      { error: "Paste a real conversation (at least a few lines) or add screenshots." },
      { status: 400 }
    );
  }

  let transcribed = false;
  const pieces: { text: string; source: string }[] = [];
  if (text.length >= 20) pieces.push({ text, source: "text" });

  if (images.length > 0) {
    const out = await chatVision(
      "You transcribe WhatsApp bargaining screenshots into plain-text dialogue. " +
        "Output ONLY the conversation, one line per message, prefixed 'Me:' for the " +
        "right-side (sent) bubbles and 'Shop:' for the left-side (received) bubbles, " +
        "in order. No commentary, no markdown.",
      "Transcribe this bargaining conversation exactly.",
      images
    );
    if (out && out.trim().length >= 20) {
      pieces.push({ text: out.trim(), source: "photo" });
      transcribed = true;
    } else if (pieces.length === 0) {
      return NextResponse.json(
        {
          error:
            "Could not read the screenshots (the vision agent needs a GEMINI_TOKEN in Admin -> Keys). Paste the conversation as text instead.",
        },
        { status: 400 }
      );
    }
  }

  for (const p of pieces) {
    const ex = addTraining(p.text, body.note ? String(body.note) : undefined);
    await sbInsert("agent_training", [
      { text: ex.text, note: ex.note ?? null, added_by: session.email, source: p.source },
    ]);
  }

  return NextResponse.json({ ok: true, transcribed, examples: await allExamples() });
}
