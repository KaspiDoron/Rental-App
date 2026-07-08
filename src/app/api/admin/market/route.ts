import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { listFloors, ownerSetFloor, refreshRegionFloors } from "@/lib/market";

// Owner control of the market-floor price table that anchors the agent's
// single bargaining ask. GET lists all rows; PATCH edits a row by hand
// (owner rows survive AI refreshes); POST re-runs the AI research for an area.

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ rows: await listFloors() });
}

export async function PATCH(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  const floor = Number(body.floor);
  if (!id || !(floor > 0)) {
    return NextResponse.json({ error: "id and floor required" }, { status: 400 });
  }
  const typical = body.typical !== undefined ? Number(body.typical) || null : undefined;
  await ownerSetFloor(id, floor, typical);
  return NextResponse.json({ ok: true });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const region = String(body.region ?? "").trim().toLowerCase();
  if (!region) return NextResponse.json({ error: "region required" }, { status: 400 });
  const ok = await refreshRegionFloors(region);
  return NextResponse.json({
    ok,
    note: ok ? "AI research complete." : "No AI provider available right now.",
  });
}
