import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import {
  listSponsors,
  addSponsor,
  setSponsorActive,
  removeSponsor,
} from "@/lib/sponsored";

// Owner management of paid shop placements ("Recommended" glow cards).

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ rows: await listSponsors() });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Shop name required." }, { status: 400 });
  await addSponsor({
    name,
    place_query: body.placeQuery ? String(body.placeQuery) : undefined,
    phone: body.phone ? String(body.phone) : undefined,
    notes: body.notes ? String(body.notes) : undefined,
  });
  return NextResponse.json({ ok: true, rows: await listSponsors() });
}

export async function PATCH(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await setSponsorActive(id, Boolean(body.active));
  return NextResponse.json({ ok: true, rows: await listSponsors() });
}

export async function DELETE(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await removeSponsor(id);
  return NextResponse.json({ ok: true, rows: await listSponsors() });
}
