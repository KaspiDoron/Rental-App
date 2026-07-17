import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect, sbUpdate, sbDelete } from "@/lib/runtime-config";

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

  // Attach the reply thread for each report so management sees the full,
  // two-way conversation (user replies + prior owner/admin answers).
  let replies: {
    id: number;
    feedback_id: number;
    author_role: string;
    author_email: string | null;
    body: string;
    created_at: string;
  }[] = [];
  if (rows.length) {
    const ids = rows.map((r) => r.id).join(",");
    replies = await sbSelect<{
      id: number;
      feedback_id: number;
      author_role: string;
      author_email: string | null;
      body: string;
      created_at: string;
    }>(
      "feedback_replies",
      `select=id,feedback_id,author_role,author_email,body,created_at&feedback_id=in.(${ids})&order=created_at.asc&limit=500`
    ).catch(() => []);
  }
  const repliesById: Record<number, typeof replies> = {};
  for (const r of replies) (repliesById[r.feedback_id] ??= []).push(r);

  return NextResponse.json({
    feedback: rows.map((r) => ({
      ...r,
      images: byId[r.id] ?? [],
      replies: repliesById[r.id] ?? [],
    })),
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

// Permanently delete a feedback report (and its screenshots). Owner/management
// only - for spam or resolved noise the owner wants gone for good.
export async function DELETE(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  // Remove any attached screenshots first (best-effort), then the row itself.
  await sbDelete("feedback_images", `feedback_id=eq.${id}`).catch(() => {});
  await sbDelete("feedback", `id=eq.${id}`);
  return NextResponse.json({ ok: true });
}
