import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { runMapsDiagnostics } from "@/lib/google";

// Management-only: fire a real request at each Google Maps API and report the
// exact result, so a broken key/console setup is diagnosed in one tap.
export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json(await runMapsDiagnostics());
}
