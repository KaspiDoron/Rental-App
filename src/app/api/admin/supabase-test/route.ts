import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { supabaseDiagnostics } from "@/lib/runtime-config";

// Management-only: live Supabase connection check with an exact diagnosis
// (wrong key type, invalid key, missing table, unreachable URL...).
export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json(await supabaseDiagnostics());
}
