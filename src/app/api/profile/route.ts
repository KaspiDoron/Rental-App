import { NextResponse } from "next/server";
import { runProfiler } from "@/lib/agents";
import { aiEnabled } from "@/lib/ai";

export async function POST(req: Request) {
  const { text, durationDays } = await req
    .json()
    .catch(() => ({ text: "" }));
  if (!text || typeof text !== "string" || text.trim().length < 3) {
    return NextResponse.json(
      { error: "Describe the vehicle you want (at least a few words)." },
      { status: 400 }
    );
  }
  const rfq = await runProfiler(text, durationDays);
  return NextResponse.json({ rfq, aiEnabled: aiEnabled() });
}
