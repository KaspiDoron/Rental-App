import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { launchKpis } from "@/lib/ops/launch-kpis";
import { inboundInflight } from "@/lib/wa/inbound-gate";

// THE LAUNCH GO/NO-GO CARD (owner report 4, scale #10). One management-gated
// read that assembles the five numbers the owner needs before opening the doors
// to hundreds: true reply p50/p95, sends vs caps, AI spillover depth, host
// occupancy + cluster warning, and DB row growth. Every field says "unknown"
// rather than a confident zero when its source cannot be read.

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const kpis = await launchKpis().catch(() => null);
  if (!kpis) {
    return NextResponse.json(
      { error: "Could not assemble launch KPIs - the data sources were unreadable." },
      { status: 503 }
    );
  }
  // The in-process concurrency gate's live depth (scale #7) rounds out the card.
  return NextResponse.json({ ...kpis, inbound: inboundInflight() });
}
