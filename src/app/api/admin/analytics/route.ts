import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { analytics, hydrateTactics } from "@/lib/memory";
import { fieldKpis } from "@/lib/kpis";

export async function GET() {
  const session = await requireManagement();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // HYDRATE FIRST (3.5): analytics() serves the in-process singleton, and on a
  // fresh serverless instance that singleton is the STARTER playbook - so the
  // panel showed shipped priors as live results until some other async path
  // happened to hydrate. One awaited refresh (30s-cached) makes this route
  // report the durable cross-instance numbers; analytics() itself now also
  // labels seeded-vs-measured so priors can never masquerade as evidence.
  await hydrateTactics();
  // DURABLE field KPIs computed from the tables (discount margin, conversion,
  // escalation) so they survive restarts/scale-out.
  const field = await fieldKpis().catch(() => null);
  return NextResponse.json({ ...analytics(), field });
}

// Allow the durable KPI queries (a few bounded selects) to complete.
export const maxDuration = 30;
