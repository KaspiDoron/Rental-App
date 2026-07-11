import { NextResponse } from "next/server";
import { writeFeedback } from "@/lib/agents";
import { getSession } from "@/lib/session";

// AI writing assist: rough notes -> a clear, structured feedback report.
export async function POST(req: Request) {
  // Signed-in only - this is an LLM call and must not be an open faucet.
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
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
