import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { listFaq, addFaq, removeFaq } from "@/lib/faq";
import { chat } from "@/lib/ai";

// FAQ: public GET (anyone can read the popular questions); management POST to
// add a Q+A (optionally AI-written), and DELETE to remove one.

export async function GET() {
  return NextResponse.json({ items: await listFaq() });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const q = String(body.question ?? "").trim();
  if (!q) return NextResponse.json({ error: "A question is required." }, { status: 400 });

  let a = String(body.answer ?? "").trim();
  // AI-write the answer when the manager did not type one.
  if (!a && body.generate) {
    const out = await chat([
      {
        role: "system",
        content:
          "You write ONE clear, friendly FAQ answer for WheelDeal - an app whose AI " +
          "agents find and bargain the cheapest car/scooter/motorbike rentals near a " +
          "traveller's hotel, worldwide, in the shop's own language. Answer in 2-4 " +
          "short sentences, globally applicable (never assume a country or currency), " +
          "honest, plain text only. Do not restate the question.",
      },
      { role: "user", content: `Question: ${q}` },
    ]);
    a = (out ?? "").trim();
    if (!a) {
      return NextResponse.json(
        { error: "The AI could not write an answer (check an AI key in Keys) - type one instead." },
        { status: 502 }
      );
    }
  }
  if (!a) return NextResponse.json({ error: "Provide an answer or enable AI generate." }, { status: 400 });

  const items = await addFaq(q, a);
  return NextResponse.json({ ok: true, items });
}

export async function DELETE(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const items = await removeFaq(id);
  return NextResponse.json({ ok: true, items });
}

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
