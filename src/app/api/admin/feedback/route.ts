import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect, sbUpdate } from "@/lib/runtime-config";

// In-app feedback inbox with a triage WORKFLOW: every report has a status
// (open / in-progress / resolved / dismissed) and an owner note, so feedback
// is actually worked through, not just read. Stored in Supabase - no email
// service required.
export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rows = await sbSelect<{ id: number; image_count: number }>(
    "feedback",
    "select=id,category,body,reporter_email,is_real_issue,severity,summary,triage_reason,image_count,status,owner_note,created_at&order=created_at.desc&limit=100"
  );

  // Attach screenshots for the rows that have them.
  const withImages = rows.filter((r) => (r.image_count ?? 0) > 0).map((r) => r.id);
  let images: { feedback_id: number; data_url: string }[] = [];
  if (withImages.length) {
    images = await sbSelect<{ feedback_id: number; data_url: string }>(
      "feedback_images",
      `select=feedback_id,data_url&feedback_id=in.(${withImages.join(",")})&limit=200`
    );
  }
  const byId: Record<number, string[]> = {};
  for (const img of images) {
    (byId[img.feedback_id] ??= []).push(img.data_url);
  }

  return NextResponse.json({
    feedback: rows.map((r) => ({ ...r, images: byId[r.id] ?? [] })),
  });
}

const STATUSES = ["open", "in-progress", "resolved", "dismissed"];

// Update a report's status and/or owner note (the triage workflow).
export async function PATCH(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const patch: Record<string, unknown> = {};
  if (body.status && STATUSES.includes(String(body.status))) {
    patch.status = body.status;
    patch.resolved_at =
      body.status === "resolved" || body.status === "dismissed"
        ? new Date().toISOString()
        : null;
  }
  if (body.note !== undefined) patch.owner_note = String(body.note).slice(0, 2000);
  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  await sbUpdate("feedback", `id=eq.${id}`, patch);
  return NextResponse.json({ ok: true });
}
