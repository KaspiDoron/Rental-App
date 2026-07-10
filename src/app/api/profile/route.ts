import { NextResponse } from "next/server";
import { runProfiler } from "@/lib/agents";
import { aiEnabled } from "@/lib/ai";
import { getSession } from "@/lib/session";
import { sbInsert } from "@/lib/runtime-config";

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
  // The session identity powers the stable per-user voice persona, so this
  // user's first message always sounds like the same distinct human.
  const session = await getSession();
  const rfq = await runProfiler(text, durationDays, session?.email);
  await sbInsert("searches", [
    {
      user_email: session?.email ?? null,
      query_text: text.slice(0, 500),
      vehicle_class: rfq.vehicleClass,
      source: "profiler",
      results: 0,
    },
  ]);

  return NextResponse.json({ rfq, aiEnabled: await aiEnabled() });
}

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
