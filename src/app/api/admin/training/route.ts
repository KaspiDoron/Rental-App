import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { addTraining, listTraining, deleteTraining, updateTraining } from "@/lib/memory";
import { sbInsert, sbSelect, sbDelete, sbUpdate } from "@/lib/runtime-config";
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
    const { getPrompt } = await import("@/lib/prompts");
    const out = await chatVision(
      await getPrompt("transcribe"),
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

// Delete one learned example (owner full control over agent memory). ?id=<id>
export async function DELETE(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  await sbDelete("agent_training", `id=eq.${id}`);
  deleteTraining(id);
  return NextResponse.json({ ok: true, examples: await allExamples() });
}

// Edit the text of one learned example. Body: { id, text }
export async function PATCH(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  const text = String(body.text ?? "").trim();
  if (!Number.isFinite(id) || text.length < 5) {
    return NextResponse.json({ error: "Need an id and some text." }, { status: 400 });
  }
  await sbUpdate("agent_training", `id=eq.${id}`, { text: text.slice(0, 4000) });
  updateTraining(id, text);
  return NextResponse.json({ ok: true, examples: await allExamples() });
}
