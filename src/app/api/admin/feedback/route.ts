import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect, sbUpdate, sbDelete } from "@/lib/runtime-config";

// In-app feedback inbox with a triage WORKFLOW: every report has a status
// (open / in-progress / resolved / dismissed) and an owner note, so feedback
// is actually worked through, not just read. Stored in Supabase - no email
// service required.
/**
 * How many screenshots the inbox inlines PER REPORT, and in total.
 *
 * Screenshots are base64 data URLs in a text column (capped at ~4MB each by the
 * submit route) and this endpoint used to inline up to 200 of them into ONE
 * JSON response - a response that could reach several hundred megabytes and
 * that the owner's phone has to parse before the panel paints. The rest are
 * counted, not sent: `imageCount` tells the panel there are more, and deleting
 * a report still removes every one of them.
 */
const IMAGES_PER_REPORT = 2;
const IMAGES_TOTAL = 24;

const CATEGORIES = ["bug", "ui", "performance", "crash", "suggestion", "question", "other"];

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // CATEGORIES THAT DO SOMETHING (owner report 5 #18). They were collected,
  // stored and displayed, and drove NOTHING - no filter, no counts - so the
  // only axis the owner could slice the inbox on was triage severity. The
  // filter is applied in the QUERY (so a busy category is not truncated by the
  // 100-row limit before the owner sees it) and the counts are computed over
  // the unfiltered table, so the chips keep their numbers while one is active.
  const url = new URL(req.url);
  const category = String(url.searchParams.get("category") ?? "").trim().toLowerCase();
  const filtered = CATEGORIES.includes(category);
  const select =
    "select=id,category,body,reporter_email,is_real_issue,severity,summary,triage_reason,image_count,status,owner_note,created_at";

  const [rows, allCategories] = await Promise.all([
    sbSelect<{ id: number; image_count: number; category: string }>(
      "feedback",
      `${select}${filtered ? `&category=eq.${encodeURIComponent(category)}` : ""}&order=created_at.desc&limit=100`
    ),
    sbSelect<{ category: string | null }>(
      "feedback",
      "select=category&order=created_at.desc&limit=1000"
    ).catch(() => [] as { category: string | null }[]),
  ]);

  const byCategory: Record<string, number> = {};
  for (const r of allCategories) {
    const key = (r.category ?? "other").toLowerCase();
    byCategory[key] = (byCategory[key] ?? 0) + 1;
  }

  // Attach screenshots for the rows that have them - BOUNDED (see the caps).
  const withImages = rows
    .filter((r) => (r.image_count ?? 0) > 0)
    .map((r) => r.id)
    .slice(0, IMAGES_TOTAL);
  let images: { feedback_id: number; data_url: string }[] = [];
  if (withImages.length) {
    images = await sbSelect<{ feedback_id: number; data_url: string }>(
      "feedback_images",
      `select=feedback_id,data_url&feedback_id=in.(${withImages.join(",")})&limit=${IMAGES_TOTAL * IMAGES_PER_REPORT}`
    );
  }
  const byId: Record<number, string[]> = {};
  let inlined = 0;
  for (const img of images) {
    const bucket = (byId[img.feedback_id] ??= []);
    if (bucket.length >= IMAGES_PER_REPORT || inlined >= IMAGES_TOTAL) continue;
    bucket.push(img.data_url);
    inlined += 1;
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
      /** How many screenshots exist, vs how many are inlined above. */
      imageCount: r.image_count ?? 0,
      replies: repliesById[r.id] ?? [],
    })),
    /** Every category with a count - the owner's filter chips. */
    byCategory,
    categories: CATEGORIES,
    /** Which filter produced this list, so the panel cannot claim another. */
    category: filtered ? category : null,
    total: rows.length,
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
