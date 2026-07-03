import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";

// In-app feedback inbox: every triaged report is stored in Supabase, so the
// team reads feedback right here - no email service required. (Resend email
// delivery stays optional on top.)
export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rows = await sbSelect(
    "feedback",
    "select=id,category,body,reporter_email,is_real_issue,severity,summary,triage_reason,image_count,created_at&order=created_at.desc&limit=100"
  );
  return NextResponse.json({ feedback: rows });
}
