import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { suggestScenario } from "@/lib/graph/scenarios";

// Suggest fresh AI-generated rental-shop scenarios for the Playground. The
// client sends the labels it already tested; each call returns ONE new,
// deliberately different scenario (built-in pool when no AI key is set).
export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const exclude = Array.isArray(body.exclude)
    ? body.exclude.map((s: unknown) => String(s).slice(0, 80)).slice(0, 24)
    : [];
  const scenario = await suggestScenario(exclude);
  return NextResponse.json({ scenario });
}

export const maxDuration = 60;
