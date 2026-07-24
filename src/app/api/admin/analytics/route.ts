import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { analytics } from "@/lib/memory";
import { fieldKpis } from "@/lib/kpis";

export async function GET() {
  const session = await requireManagement();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // In-memory tactic stats (fast) + DURABLE field KPIs computed from the tables
  // (discount margin, conversion, escalation) so they survive restarts/scale-out.
  const field = await fieldKpis().catch(() => null);
  return NextResponse.json({ ...analytics(), field });
}

// Allow the durable KPI queries (a few bounded selects) to complete.
export const maxDuration = 30;
