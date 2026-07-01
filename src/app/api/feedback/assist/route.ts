import { NextResponse } from "next/server";
import { writeFeedback } from "@/lib/agents";

// AI writing assist: rough notes -> a clear, structured feedback report.
export async function POST(req: Request) {
  const { category, notes } = await req.json().catch(() => ({}));
  if (!notes || String(notes).trim().length < 3) {
    return NextResponse.json(
      { error: "Jot down a few words first and the assistant will expand them." },
      { status: 400 }
    );
  }
  const text = await writeFeedback(String(category || "bug"), String(notes));
  return NextResponse.json({ text });
}
