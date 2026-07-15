import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { scoresSummary } from "@/lib/graph/judge";

// The judge team's output (owner/manager only): recent per-move + chief-judge
// scores, plus the per-tactic learning table that the scores feed via EMA.
export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const summary = await scoresSummary();
  return NextResponse.json(summary);
}

export const maxDuration = 60;
