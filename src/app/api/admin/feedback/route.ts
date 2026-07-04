import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";

// In-app feedback inbox: every triaged report is stored in Supabase, so the
// team reads feedback right here - no email service required. (Resend email
// delivery stays optional on top.)
export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rows = await sbSelect<{ id: number; image_count: number }>(
    "feedback",
    "select=id,category,body,reporter_email,is_real_issue,severity,summary,triage_reason,image_count,created_at&order=created_at.desc&limit=100"
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
